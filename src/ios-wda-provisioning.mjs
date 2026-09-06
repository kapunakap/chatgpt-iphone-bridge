import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { BOOTSTRAP_PATH } from "appium-webdriveragent";
import { provision } from "ios-mobileprovision-finder";

const execFile = promisify(execFileCallback);
const WDA_SUFFIX = ".xctrunner";

function profileDirectory(env = process.env) {
  return (
    env.IOS_PROVISIONING_PROFILE_DIR ??
    path.join(os.homedir(), "Library", "Developer", "Xcode", "UserData", "Provisioning Profiles")
  );
}

function profileBundleId(profile) {
  const teamId = profile.TeamIdentifier?.[0] ?? "";
  const applicationId = profile.Entitlements?.["application-identifier"] ?? "";
  if (teamId && applicationId.startsWith(`${teamId}.`)) return applicationId.slice(teamId.length + 1);
  return profile.Name?.split(":").slice(1).join(":").trim() ?? "";
}

function profileMetadata(profile, filePath) {
  const teamIds = [
    ...new Set(Array.isArray(profile.TeamIdentifier) ? profile.TeamIdentifier.filter(Boolean) : []),
  ];
  return {
    uuid: profile.UUID,
    teamId: teamIds[0] ?? "",
    teamIds,
    bundleId: profileBundleId(profile),
    expiresAt: profile.ExpirationDate instanceof Date ? profile.ExpirationDate : new Date(profile.ExpirationDate),
    devices: Array.isArray(profile.ProvisionedDevices) ? profile.ProvisionedDevices : [],
    platform: Array.isArray(profile.Platform) ? profile.Platform : [],
    type: profile.Type,
    filePath,
  };
}

export async function loadProvisioningProfiles(options = {}) {
  const directory = options.directory ?? profileDirectory(options.env);
  let files;
  try {
    files = await fs.readdir(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const profiles = [];
  for (const file of files.filter((name) => name.endsWith(".mobileprovision"))) {
    const filePath = path.join(directory, file);
    const decoded = provision.readFromFile(filePath);
    if (decoded?.UUID) profiles.push(profileMetadata(decoded, filePath));
  }
  return profiles;
}

export function isWdaProfile(profile) {
  return profile.bundleId === "*" || profile.bundleId.endsWith(WDA_SUFFIX);
}

export function isProfileValidForDevice(profile, udid, now = Date.now()) {
  return (
    Number.isFinite(profile.expiresAt?.getTime()) &&
    profile.expiresAt.getTime() > now &&
    profile.type === "Development" &&
    (profile.platform.length === 0 || profile.platform.includes("iOS")) &&
    profile.devices.includes(udid)
  );
}

function newest(profiles) {
  return [...profiles].sort((left, right) => right.expiresAt.getTime() - left.expiresAt.getTime())[0];
}

function validateSigningInputs({ udid, teamId, bundleIdBase }) {
  if (!/^[A-Za-z0-9-]+$/.test(udid)) throw new Error("Invalid iPhone UDID for WDA automatic signing");
  if (!/^[A-Z0-9]+$/.test(teamId)) throw new Error("Invalid development team for WDA automatic signing");
  if (!/^[A-Za-z0-9.-]+$/.test(bundleIdBase) || bundleIdBase.endsWith(WDA_SUFFIX)) {
    throw new Error("Invalid WDA bundle identifier for automatic signing");
  }
}

export function classifyXcodeSigningFailure(error) {
  const detail = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}\n${error?.message ?? ""}`;
  if (/missing Xcode-(?:Token|Username)|Invalid credentials|No Accounts/i.test(detail)) {
    return "Xcode account credentials are unavailable";
  }
  if (/Unable to find a device matching|requested device could not be found/i.test(detail)) {
    return "the selected iPhone is unavailable to Xcode";
  }
  if (/No profiles for|requires a provisioning profile|provisioning profile.*not found/i.test(detail)) {
    return "Xcode could not create a matching provisioning profile";
  }
  return "xcodebuild could not refresh the WDA provisioning profile";
}

export async function runAutomaticWdaSigning(inputs, options = {}) {
  validateSigningInputs(inputs);
  const createTemp = options.createTemp ?? (() => fs.mkdtemp(path.join(os.tmpdir(), "iphone-bridge-wda-signing-")));
  const removeTemp = options.removeTemp ?? ((directory) => fs.rm(directory, { recursive: true, force: true }));
  const run = options.execFile ?? execFile;
  const derivedData = await createTemp();
  const project = options.projectPath ?? path.join(BOOTSTRAP_PATH, "WebDriverAgent.xcodeproj");
  const args = [
    "-project",
    project,
    "-scheme",
    "WebDriverAgentRunner",
    "-configuration",
    "Debug",
    "-destination",
    `id=${inputs.udid}`,
    "-derivedDataPath",
    derivedData,
    "-jobs",
    "1",
    "-allowProvisioningUpdates",
    "-allowProvisioningDeviceRegistration",
    `DEVELOPMENT_TEAM=${inputs.teamId}`,
    "CODE_SIGN_STYLE=Automatic",
    `PRODUCT_BUNDLE_IDENTIFIER=${inputs.bundleIdBase}`,
    "build-for-testing",
  ];
  try {
    await run("xcodebuild", args, {
      timeout: options.timeoutMs ?? 10 * 60_000,
      maxBuffer: 8 * 1024 * 1024,
      env: options.env ?? process.env,
    });
  } catch (error) {
    const failure = new Error(`WDA automatic signing failed: ${classifyXcodeSigningFailure(error)}`);
    failure.code = "WDA_AUTOMATIC_SIGNING_FAILED";
    throw failure;
  } finally {
    await removeTemp(derivedData).catch(() => {});
  }
}

function uniqueSigningTargets(profiles) {
  return new Map(profiles.map((profile) => [`${profile.teamId}\0${profile.bundleId}`, profile]));
}

function bootstrapSigningTarget(profiles, udid, now) {
  const anchors = profiles.filter(
    (profile) =>
      !isWdaProfile(profile) &&
      isProfileValidForDevice(profile, udid, now) &&
      !profile.bundleId.includes("*"),
  );
  const companionAnchors = anchors.filter((profile) => profile.bundleId.endsWith(".BridgeBrowser"));
  const anchor = companionAnchors.length === 1 ? companionAnchors[0] : anchors.length === 1 ? anchors[0] : null;
  if (!anchor) return null;
  if (
    !/^[A-Z0-9]+$/.test(anchor.teamId) ||
    !/^[A-Za-z0-9.-]+$/.test(anchor.bundleId) ||
    (Array.isArray(anchor.teamIds) &&
      (anchor.teamIds.length !== 1 || anchor.teamIds[0] !== anchor.teamId))
  ) {
    return null;
  }
  const bundleIdBase = `${anchor.bundleId}.WebDriverAgentRunner`;
  return { teamId: anchor.teamId, bundleId: `${bundleIdBase}${WDA_SUFFIX}` };
}

export async function ensureFreshWdaProvisioningProfile({ udid, requestedProfileUuid }, options = {}) {
  const now = options.now?.() ?? Date.now();
  const loadProfiles = options.loadProfiles ?? (() => loadProvisioningProfiles({ env: options.env }));
  const profiles = await loadProfiles();
  const requested = requestedProfileUuid
    ? profiles.find((profile) => profile.uuid.toLowerCase() === requestedProfileUuid.toLowerCase())
    : null;

  if (requested && !isWdaProfile(requested)) {
    const error = new Error("The selected provisioning profile does not match a WDA .xctrunner bundle identifier");
    error.code = "WDA_PROFILE_BUNDLE_MISMATCH";
    throw error;
  }

  const validWda = profiles.filter((profile) => isWdaProfile(profile) && isProfileValidForDevice(profile, udid, now));
  const expiredProfileUuids = profiles
    .filter((profile) => !Number.isFinite(profile.expiresAt?.getTime()) || profile.expiresAt.getTime() <= now)
    .map((profile) => profile.uuid);
  if (!requestedProfileUuid && validWda.length > 0) {
    return { refreshed: false, validProfileUuids: validWda.map((profile) => profile.uuid), expiredProfileUuids };
  }

  const configuredTeam = options.env?.DEVELOPMENT_TEAM ?? process.env.DEVELOPMENT_TEAM;
  const configuredBundleBase = options.env?.WDA_BUNDLE_ID_BASE ?? process.env.WDA_BUNDLE_ID_BASE;
  const exactRequestedBundle = requested?.bundleId !== "*" ? requested?.bundleId : null;
  const configuredBundle = configuredBundleBase ? `${configuredBundleBase}${WDA_SUFFIX}` : null;
  const wantedTeam = configuredTeam ?? requested?.teamId;
  const wantedBundle = configuredBundle ?? exactRequestedBundle;

  if (wantedTeam && wantedBundle) {
    const replacement = newest(
      validWda.filter((profile) => profile.teamId === wantedTeam && profile.bundleId === wantedBundle),
    );
    if (replacement) {
      return {
        refreshed: false,
        profileUuid: replacement.uuid,
        validProfileUuids: validWda.map((profile) => profile.uuid),
        expiredProfileUuids,
      };
    }
  }

  let target;
  if (wantedTeam && wantedBundle) {
    target = newest(
      profiles.filter((profile) => profile.teamId === wantedTeam && profile.bundleId === wantedBundle),
    );
  } else {
    const expiredCandidates = profiles.filter(
      (profile) =>
        profile.bundleId.endsWith(WDA_SUFFIX) &&
        profile.devices.includes(udid) &&
        !isProfileValidForDevice(profile, udid, now),
    );
    const targets = uniqueSigningTargets(expiredCandidates);
    if (targets.size === 1) target = newest(expiredCandidates);
  }

  if (
    !target &&
    !requestedProfileUuid &&
    !configuredTeam &&
    !configuredBundleBase
  ) {
    target = bootstrapSigningTarget(profiles, udid, now);
  }

  if (!target) {
    return { refreshed: false, validProfileUuids: validWda.map((profile) => profile.uuid), expiredProfileUuids };
  }

  const bundleIdBase = target.bundleId.slice(0, -WDA_SUFFIX.length);
  const runSigning = options.runSigning ?? runAutomaticWdaSigning;
  await runSigning(
    { udid, teamId: target.teamId, bundleIdBase },
    options.signingOptions,
  );

  const refreshedProfiles = await loadProfiles();
  const refreshedValid = refreshedProfiles.filter(
    (profile) => isWdaProfile(profile) && isProfileValidForDevice(profile, udid, options.now?.() ?? Date.now()),
  );
  const refreshedNow = options.now?.() ?? Date.now();
  const refreshedExpired = refreshedProfiles
    .filter((profile) => !Number.isFinite(profile.expiresAt?.getTime()) || profile.expiresAt.getTime() <= refreshedNow)
    .map((profile) => profile.uuid);
  const replacement = newest(
    refreshedValid.filter((profile) => profile.teamId === target.teamId && profile.bundleId === target.bundleId),
  );
  if (!replacement) {
    const error = new Error("WDA automatic signing completed but no valid matching provisioning profile was found");
    error.code = "WDA_PROFILE_REFRESH_NOT_FOUND";
    throw error;
  }
  return {
    refreshed: true,
    profileUuid: replacement.uuid,
    expiresAt: replacement.expiresAt.toISOString(),
    validProfileUuids: refreshedValid.map((profile) => profile.uuid),
    expiredProfileUuids: refreshedExpired,
  };
}

function errorContent(error) {
  return {
    isError: true,
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
  };
}

function parseTextPayload(result) {
  const item = result?.content?.find((entry) => entry.type === "text");
  if (!item) return null;
  try {
    return { item, payload: JSON.parse(item.text) };
  } catch {
    return null;
  }
}

export class WdaProvisioningPlugin {
  constructor(options = {}) {
    this.name = "openai-local-iphone-wda-provisioning";
    this.version = "0.2.0-beta.3";
    this.ensureProfile = options.ensureProfile ?? ensureFreshWdaProvisioningProfile;
    this.validProfileUuids = new Set();
    this.expiredProfileUuids = new Set();
  }

  async beforeCall(ctx) {
    if (ctx.toolName !== "appium_prepare_ios_real_device") return;
    try {
      const outcome = await this.ensureProfile({
        udid: ctx.args.udid,
        requestedProfileUuid: ctx.args.provisioningProfileUuid,
      });
      this.validProfileUuids = new Set(outcome.validProfileUuids ?? []);
      this.expiredProfileUuids = new Set(outcome.expiredProfileUuids ?? []);
      if (ctx.args.provisioningProfileUuid && outcome.profileUuid) {
        ctx.args.provisioningProfileUuid = outcome.profileUuid;
      }
    } catch (error) {
      return errorContent(error);
    }
  }

  async afterCall(ctx, result) {
    if (ctx.toolName !== "appium_prepare_ios_real_device" || ctx.args.provisioningProfileUuid || result.isError) {
      return;
    }
    const parsed = parseTextPayload(result);
    if (!parsed?.payload?.profiles) return;
    const profiles = parsed.payload.profiles.map((profile) => ({
      ...profile,
      expired: this.expiredProfileUuids.has(profile.uuid),
      recommendedForWda: profile.recommendedForWda && this.validProfileUuids.has(profile.uuid),
    }));
    const recommendedProfiles = profiles.filter((profile) => profile.recommendedForWda);
    const payload = {
      ...parsed.payload,
      profiles,
      ...(recommendedProfiles.length > 0 ? { recommendedProfiles } : { recommendedProfiles: undefined }),
    };
    const content = result.content.map((item) =>
      item === parsed.item ? { ...item, text: JSON.stringify(payload, null, 2) } : item,
    );
    return { content };
  }

  register() {}
}
