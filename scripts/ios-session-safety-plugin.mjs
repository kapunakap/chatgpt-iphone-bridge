function errorContent(error) {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `iPhone bridge error: ${error instanceof Error ? error.message : String(error)}`,
      },
    ],
  };
}

function textResultValue(result) {
  return result?.content?.find((item) => item.type === "text")?.text ?? "";
}

function parseCapabilities(value) {
  if (value == null || value === "") return {};
  if (typeof value === "string") return JSON.parse(value);
  if (typeof value === "object" && !Array.isArray(value)) return { ...value };
  throw new Error("capabilities must be a JSON string or object");
}

function isIosPlatform(platform) {
  return typeof platform === "string" && platform.toLowerCase() === "ios";
}

function isRealDeviceWdaCapabilities(capabilities) {
  return (
    capabilities["appium:usePreinstalledWDA"] === true ||
    (typeof capabilities["appium:prebuiltWDAPath"] === "string" &&
      capabilities["appium:prebuiltWDAPath"].length > 0)
  );
}

export class IosSessionSafetyPlugin {
  constructor() {
    this.name = "kapunakap-ios-session-safety";
    this.version = "1.0.0";
    this.realIosUdid = null;
    this.pendingCreateUdid = null;
    this.sessionCreateInFlight = false;
  }

  async beforeCall(ctx) {
    if (ctx.toolName === "select_device") {
      if (!isIosPlatform(ctx.args.platform) || ctx.args.iosDeviceType !== "real") this.realIosUdid = null;
      return;
    }

    if (
      ctx.toolName !== "appium_session_management" ||
      ctx.args.action !== "create" ||
      ctx.args.platform == null
    ) {
      return;
    }

    if (this.sessionCreateInFlight) {
      return errorContent(new Error("Another Appium session creation is already in progress"));
    }

    const ownedSessions = (ctx.session?.listSessions?.() ?? []).filter((session) => session.ownership === "owned");
    if (ownedSessions.length > 0) {
      return errorContent(
        new Error(
          `An owned Appium session is already active (${ownedSessions.map((session) => session.sessionId).join(", ")}). Delete it before creating another session.`,
        ),
      );
    }

    this.pendingCreateUdid = null;
    if (!isIosPlatform(ctx.args.platform)) {
      this.sessionCreateInFlight = true;
      return;
    }

    let capabilities;
    try {
      capabilities = parseCapabilities(ctx.args.capabilities);
    } catch (error) {
      return errorContent(error);
    }

    if (!isRealDeviceWdaCapabilities(capabilities)) {
      this.sessionCreateInFlight = true;
      return;
    }

    const explicitUdid = capabilities["appium:udid"];
    if (typeof explicitUdid === "string" && explicitUdid.length > 0) {
      this.pendingCreateUdid = explicitUdid;
    } else if (this.realIosUdid) {
      capabilities["appium:udid"] = this.realIosUdid;
      this.pendingCreateUdid = this.realIosUdid;
    } else {
      return errorContent(
        new Error(
          "Real-device WDA session creation requires a selected iPhone. Call select_device with iosDeviceType=real or appium_prepare_ios_real_device first, or provide appium:udid explicitly.",
        ),
      );
    }

    if (!capabilities["appium:deviceName"]) capabilities["appium:deviceName"] = "iPhone";
    ctx.args.capabilities = JSON.stringify(capabilities);
    this.sessionCreateInFlight = true;
  }

  async afterCall(ctx, result) {
    if (ctx.toolName === "appium_session_management" && ctx.args.action === "create") {
      if (!result.isError && this.pendingCreateUdid) this.realIosUdid = this.pendingCreateUdid;
      this.pendingCreateUdid = null;
      this.sessionCreateInFlight = false;
      return;
    }

    if (result.isError) return;

    if (ctx.toolName === "appium_prepare_ios_real_device") {
      if (typeof ctx.args.udid === "string" && ctx.args.udid.length > 0) this.realIosUdid = ctx.args.udid;
      return;
    }

    if (
      ctx.toolName !== "select_device" ||
      !isIosPlatform(ctx.args.platform) ||
      ctx.args.iosDeviceType !== "real"
    ) {
      return;
    }

    try {
      const selected = JSON.parse(textResultValue(result));
      const udid = selected?.capabilities?.["appium:udid"];
      if (typeof udid === "string" && udid.length > 0) this.realIosUdid = udid;
    } catch {
      // A later successful preparation call can still provide the authoritative UDID.
    }
  }

  register() {}
}
