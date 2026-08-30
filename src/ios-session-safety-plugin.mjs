const PRIVILEGED_TOOLS = new Set([
  "appium_app_lifecycle",
  "appium_driver_settings",
  "appium_geolocation",
  "appium_mobile_clipboard",
  "appium_mobile_device_control",
  "appium_mobile_file",
  "appium_mobile_permissions",
]);

function errorContent(message) {
  return {
    isError: true,
    content: [{ type: "text", text: `iPhone bridge policy: ${message}` }],
  };
}

function enabledPrivilegedTools() {
  const raw = process.env.APPIUM_BRIDGE_PRIVILEGED_TOOLS ?? "";
  return new Set(raw.split(",").map((value) => value.trim()).filter(Boolean));
}

export class IosSessionSafetyPlugin {
  constructor() {
    this.name = "openai-local-iphone-policy";
    this.version = "0.2.0-beta.1";
  }

  async beforeCall(ctx) {
    if (process.env.APPIUM_BRIDGE_UNSAFE_FULL_APPIUM === "true") return;

    if (PRIVILEGED_TOOLS.has(ctx.toolName)) {
      const enabled = enabledPrivilegedTools();
      if (!enabled.has("all") && !enabled.has(ctx.toolName)) {
        return errorContent(
          `${ctx.toolName} is disabled by default; enable it locally with APPIUM_BRIDGE_PRIVILEGED_TOOLS`,
        );
      }
    }

    if (ctx.toolName === "select_device") {
      if (ctx.args.platform !== "ios" || ctx.args.iosDeviceType !== "real") {
        return errorContent("this bridge only selects real iOS devices");
      }
      return;
    }

    if (ctx.toolName === "appium_prepare_ios_real_device") {
      return errorContent("use appium_prepare_ios_real_device_async through the tunnel");
    }

    if (ctx.toolName !== "appium_session_management") return;

    if (ctx.args.remoteServerUrl != null) {
      return errorContent("remote Appium server URLs are disabled");
    }
    if (["attach", "detach"].includes(ctx.args.action)) {
      return errorContent("remote session attach and detach are disabled");
    }
    if (ctx.args.action === "create") {
      return errorContent("use appium_create_session_async through the tunnel");
    }
  }

  register() {}
}

export { PRIVILEGED_TOOLS };
