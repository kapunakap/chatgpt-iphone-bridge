import assert from "node:assert/strict";
import test from "node:test";

import {
  WdaProvisioningPlugin,
  classifyXcodeSigningFailure,
  ensureFreshWdaProvisioningProfile,
  runAutomaticWdaSigning,
} from "./ios-wda-provisioning.mjs";

const NOW = Date.parse("2026-09-06T12:00:00Z");
const UDID = "00008110-001234567890801E";

function profile(overrides = {}) {
  return {
    uuid: "expired-wda",
    teamId: "TEAM123456",
    bundleId: "com.example.WebDriverAgentRunner.xctrunner",
    expiresAt: new Date("2026-09-03T00:00:00Z"),
    devices: [UDID],
    platform: ["iOS"],
    type: "Development",
    filePath: "/profiles/expired.mobileprovision",
    ...overrides,
  };
}

test("valid WDA discovery does not run automatic signing", async () => {
  let signingCalls = 0;
  const fresh = profile({ uuid: "fresh-wda", expiresAt: new Date("2026-09-12T00:00:00Z") });
  const result = await ensureFreshWdaProvisioningProfile(
    { udid: UDID },
    {
      now: () => NOW,
      loadProfiles: async () => [fresh],
      runSigning: async () => {
        signingCalls += 1;
      },
    },
  );
  assert.equal(signingCalls, 0);
  assert.deepEqual(result.validProfileUuids, ["fresh-wda"]);
});

test("expired WDA profile is refreshed and replaced with the matching valid profile", async () => {
  const expired = profile();
  const fresh = profile({ uuid: "fresh-wda", expiresAt: new Date("2026-09-12T00:00:00Z") });
  let loads = 0;
  let signingInputs;
  const result = await ensureFreshWdaProvisioningProfile(
    { udid: UDID, requestedProfileUuid: expired.uuid },
    {
      now: () => NOW,
      loadProfiles: async () => (++loads === 1 ? [expired] : [expired, fresh]),
      runSigning: async (inputs) => {
        signingInputs = inputs;
      },
    },
  );
  assert.deepEqual(signingInputs, {
    udid: UDID,
    teamId: "TEAM123456",
    bundleIdBase: "com.example.WebDriverAgentRunner",
  });
  assert.equal(result.refreshed, true);
  assert.equal(result.profileUuid, "fresh-wda");
  assert.deepEqual(result.validProfileUuids, ["fresh-wda"]);
});

test("a valid replacement is reused without another Xcode build", async () => {
  const expired = profile();
  const fresh = profile({ uuid: "fresh-wda", expiresAt: new Date("2026-09-12T00:00:00Z") });
  const result = await ensureFreshWdaProvisioningProfile(
    { udid: UDID, requestedProfileUuid: expired.uuid },
    {
      now: () => NOW,
      loadProfiles: async () => [expired, fresh],
      runSigning: async () => assert.fail("automatic signing should not run"),
    },
  );
  assert.equal(result.profileUuid, "fresh-wda");
  assert.equal(result.refreshed, false);
});

test("missing WDA bootstraps from the unique BridgeBrowser anchor", async () => {
  const anchor = profile({
    uuid: "bridge-browser",
    bundleId: "com.example.BridgeBrowser",
    expiresAt: new Date("2026-09-12T00:00:00Z"),
  });
  const other = profile({
    uuid: "other-app",
    bundleId: "com.example.OtherApp",
    expiresAt: new Date("2026-09-12T00:00:00Z"),
  });
  const fresh = profile({
    uuid: "fresh-bootstrap-wda",
    bundleId: "com.example.BridgeBrowser.WebDriverAgentRunner.xctrunner",
    expiresAt: new Date("2026-09-12T00:00:00Z"),
  });
  let loads = 0;
  let signingInputs;
  const result = await ensureFreshWdaProvisioningProfile(
    { udid: UDID },
    {
      now: () => NOW,
      loadProfiles: async () => (++loads === 1 ? [other, anchor] : [other, anchor, fresh]),
      runSigning: async (inputs) => {
        signingInputs = inputs;
      },
    },
  );
  assert.deepEqual(signingInputs, {
    udid: UDID,
    teamId: "TEAM123456",
    bundleIdBase: "com.example.BridgeBrowser.WebDriverAgentRunner",
  });
  assert.equal(result.refreshed, true);
  assert.equal(result.profileUuid, "fresh-bootstrap-wda");
});

test("missing WDA falls back to the only valid explicit development anchor", async () => {
  const anchor = profile({
    uuid: "only-app",
    bundleId: "com.example.OnlyApp",
    expiresAt: new Date("2026-09-12T00:00:00Z"),
  });
  const fresh = profile({
    uuid: "fresh-fallback-wda",
    bundleId: "com.example.OnlyApp.WebDriverAgentRunner.xctrunner",
    expiresAt: new Date("2026-09-12T00:00:00Z"),
  });
  let loads = 0;
  let signingInputs;
  const result = await ensureFreshWdaProvisioningProfile(
    { udid: UDID },
    {
      now: () => NOW,
      loadProfiles: async () => (++loads === 1 ? [anchor] : [anchor, fresh]),
      runSigning: async (inputs) => {
        signingInputs = inputs;
      },
    },
  );
  assert.equal(signingInputs.bundleIdBase, "com.example.OnlyApp.WebDriverAgentRunner");
  assert.equal(result.profileUuid, "fresh-fallback-wda");
});

test("missing WDA refuses ambiguous companion, fallback, and team anchors", async (t) => {
  const freshDate = new Date("2026-09-12T00:00:00Z");
  const cases = [
    {
      name: "companion anchors",
      profiles: [
        profile({ uuid: "bridge-a", bundleId: "com.example.a.BridgeBrowser", expiresAt: freshDate }),
        profile({ uuid: "bridge-b", bundleId: "com.example.b.BridgeBrowser", expiresAt: freshDate }),
      ],
    },
    {
      name: "fallback anchors",
      profiles: [
        profile({ uuid: "app-a", bundleId: "com.example.AppA", expiresAt: freshDate }),
        profile({ uuid: "app-b", bundleId: "com.example.AppB", expiresAt: freshDate }),
      ],
    },
    {
      name: "profile team",
      profiles: [
        profile({
          uuid: "ambiguous-team",
          bundleId: "com.example.BridgeBrowser",
          expiresAt: freshDate,
          teamIds: ["TEAM123456", "TEAM654321"],
        }),
        profile({ uuid: "otherwise-valid", bundleId: "com.example.OtherApp", expiresAt: freshDate }),
      ],
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const result = await ensureFreshWdaProvisioningProfile(
        { udid: UDID },
        {
          now: () => NOW,
          loadProfiles: async () => item.profiles,
          runSigning: async () => assert.fail("ambiguous anchors must not trigger signing"),
        },
      );
      assert.equal(result.refreshed, false);
      assert.deepEqual(result.validProfileUuids, []);
    });
  }
});

test("missing WDA ignores wildcard, non-development, other-device, and expired anchors", async () => {
  const profiles = [
    profile({
      uuid: "wildcard",
      bundleId: "com.example.*",
      expiresAt: new Date("2026-09-12T00:00:00Z"),
    }),
    profile({
      uuid: "distribution",
      bundleId: "com.example.DistributionApp",
      expiresAt: new Date("2026-09-12T00:00:00Z"),
      type: "Distribution",
    }),
    profile({
      uuid: "other-device",
      bundleId: "com.example.OtherDeviceApp",
      expiresAt: new Date("2026-09-12T00:00:00Z"),
      devices: ["00008110-009999999999801E"],
    }),
    profile({ uuid: "expired-app", bundleId: "com.example.ExpiredApp" }),
  ];
  const result = await ensureFreshWdaProvisioningProfile(
    { udid: UDID },
    {
      now: () => NOW,
      loadProfiles: async () => profiles,
      runSigning: async () => assert.fail("invalid anchors must not trigger signing"),
    },
  );
  assert.equal(result.refreshed, false);
  assert.deepEqual(result.validProfileUuids, []);
});

test("an explicit missing profile UUID does not trigger anchor bootstrap", async () => {
  const anchor = profile({
    uuid: "bridge-browser",
    bundleId: "com.example.BridgeBrowser",
    expiresAt: new Date("2026-09-12T00:00:00Z"),
  });
  const result = await ensureFreshWdaProvisioningProfile(
    { udid: UDID, requestedProfileUuid: "missing-requested-profile" },
    {
      now: () => NOW,
      loadProfiles: async () => [anchor],
      runSigning: async () => assert.fail("explicit profile behavior must remain discovery-only"),
    },
  );
  assert.equal(result.refreshed, false);
  assert.deepEqual(result.validProfileUuids, []);
});

test("non-WDA profile selection fails before Appium can create a bundle mismatch", async () => {
  await assert.rejects(
    ensureFreshWdaProvisioningProfile(
      { udid: UDID, requestedProfileUuid: "browser-profile" },
      {
        now: () => NOW,
        loadProfiles: async () => [
          profile({
            uuid: "browser-profile",
            bundleId: "com.example.BridgeBrowser",
            expiresAt: new Date("2026-09-12T00:00:00Z"),
          }),
        ],
      },
    ),
    /does not match a WDA \.xctrunner/,
  );
});

test("automatic signing uses the device destination and provisioning update flags", async () => {
  let invocation;
  let removed;
  await runAutomaticWdaSigning(
    { udid: UDID, teamId: "TEAM123456", bundleIdBase: "com.example.WebDriverAgentRunner" },
    {
      projectPath: "/wda/WebDriverAgent.xcodeproj",
      createTemp: async () => "/temporary/wda-derived",
      removeTemp: async (directory) => {
        removed = directory;
      },
      execFile: async (command, args) => {
        invocation = { command, args };
      },
    },
  );
  assert.equal(invocation.command, "xcodebuild");
  assert.ok(invocation.args.includes("-allowProvisioningUpdates"));
  assert.ok(invocation.args.includes("-allowProvisioningDeviceRegistration"));
  assert.ok(invocation.args.includes(`id=${UDID}`));
  assert.ok(invocation.args.includes("PRODUCT_BUNDLE_IDENTIFIER=com.example.WebDriverAgentRunner"));
  assert.equal(removed, "/temporary/wda-derived");
});

test("automatic signing errors are classified without returning raw account output", async () => {
  let removed = false;
  await assert.rejects(
    runAutomaticWdaSigning(
      { udid: UDID, teamId: "TEAM123456", bundleIdBase: "com.example.WebDriverAgentRunner" },
      {
        createTemp: async () => "/temporary/wda-derived",
        removeTemp: async () => {
          removed = true;
        },
        execFile: async () => {
          throw Object.assign(new Error("raw-private-value"), { stderr: "missing Xcode-Token for private@example.test" });
        },
      },
    ),
    (error) => {
      assert.match(error.message, /credentials are unavailable/);
      assert.doesNotMatch(error.message, /private@example|raw-private/);
      return true;
    },
  );
  assert.equal(removed, true);
  assert.equal(
    classifyXcodeSigningFailure({ stderr: "Unable to find a device matching the provided destination" }),
    "the selected iPhone is unavailable to Xcode",
  );
});

test("worker plugin replaces an expired requested UUID before the Appium pipeline", async () => {
  const plugin = new WdaProvisioningPlugin({
    ensureProfile: async () => ({ profileUuid: "fresh-wda", validProfileUuids: ["fresh-wda"] }),
  });
  const args = { udid: UDID, provisioningProfileUuid: "expired-wda" };
  assert.equal(await plugin.beforeCall({ toolName: "appium_prepare_ios_real_device", args }), undefined);
  assert.equal(args.provisioningProfileUuid, "fresh-wda");
});

test("worker discovery marks expired profiles and recommends only valid WDA profiles", async () => {
  const plugin = new WdaProvisioningPlugin({
    ensureProfile: async () => ({
      validProfileUuids: ["fresh-wda"],
      expiredProfileUuids: ["expired-wda"],
    }),
  });
  const ctx = { toolName: "appium_prepare_ios_real_device", args: { udid: UDID } };
  await plugin.beforeCall(ctx);
  const result = await plugin.afterCall(ctx, {
    isError: false,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          mode: "discovery",
          profiles: [
            { uuid: "expired-wda", recommendedForWda: true },
            { uuid: "fresh-wda", recommendedForWda: true },
          ],
          recommendedProfiles: [{ uuid: "expired-wda", recommendedForWda: true }],
        }),
      },
    ],
  });
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.profiles[0].expired, true);
  assert.equal(payload.profiles[0].recommendedForWda, false);
  assert.deepEqual(payload.recommendedProfiles.map((item) => item.uuid), ["fresh-wda"]);
});
