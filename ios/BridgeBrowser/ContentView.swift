import SwiftUI

struct ContentView: View {
  @ObservedObject var model: AppModel
  @ObservedObject private var relay: RelayClient
  @ObservedObject private var browser: BrowserController
  @State private var showScanner = false

  init(model: AppModel) {
    self.model = model
    relay = model.relay
    browser = model.browser
  }

  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        if model.activeSessionId == nil { statusBar }
        if model.credentials == nil { pairingView } else { pairedView }
      }
      .navigationTitle("Bridge Browser")
      .toolbar(model.activeSessionId == nil ? .visible : .hidden, for: .navigationBar)
      .sheet(isPresented: $showScanner) {
        QRCodeScanner(
          onCode: { code in
            model.pairingText = code
            showScanner = false
            Task { await model.pair() }
          },
          onError: { message in
            showScanner = false
            model.pairingText = ""
            model.reportError(message)
          }
        )
        .ignoresSafeArea()
      }
    }
  }

  private var statusBar: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack {
        Circle().fill(relay.secureReady ? .green : relay.relayConnected ? .orange : .gray).frame(
          width: 10, height: 10)
        Text(model.statusMessage).font(.subheadline).lineLimit(1)
          .accessibilityIdentifier("bridge.status")
        Spacer()
        if model.activeSessionId != nil {
          Text("ACTIVE").font(.caption.bold()).foregroundStyle(.red)
        }
      }
      if let error = model.errorMessage ?? relay.lastError {
        Text(error).font(.caption).foregroundStyle(.red).lineLimit(2)
          .accessibilityIdentifier("bridge.error")
      }
    }
    .padding(.horizontal)
    .padding(.vertical, 8)
    .background(.thinMaterial)
  }

  private var pairingView: some View {
    Form {
      Section("Pair with the Mac") {
        Text("Run npm run cellular:pair on the Mac. Scan its QR or paste the full pairing payload.")
          .font(.footnote)
        TextEditor(text: $model.pairingText)
          .frame(minHeight: 120)
          .font(.system(.caption, design: .monospaced))
          .accessibilityIdentifier("bridge.pairing-payload")
        Button("Scan pairing QR") { showScanner = true }
          .accessibilityIdentifier("bridge.scan-pairing")
        Button("Pair") { Task { await model.pair() } }
          .disabled(model.pairingText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          .accessibilityIdentifier("bridge.pair")
      }
      Section("Free prototype limit") {
        Text(
          "A free Apple Personal Team build expires after 7 days. Reinstall it from Xcode each week."
        )
        .font(.footnote)
      }
    }
  }

  @ViewBuilder private var pairedView: some View {
    if let pending = model.pendingApproval {
      approvalView(pending)
    }
    if model.activeSessionId != nil {
      browserToolbar
      BrowserView(controller: browser)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    } else {
      Form {
        Section("Connection") {
          LabeledContent("Relay", value: relay.relayConnected ? "Connected" : "Disconnected")
            .accessibilityIdentifier("bridge.relay-status")
          LabeledContent("Mac", value: relay.hostOnline ? "Online" : "Offline")
            .accessibilityIdentifier("bridge.host-status")
          LabeledContent("Encryption", value: relay.secureReady ? "Ready" : "Waiting")
            .accessibilityIdentifier("bridge.encryption-status")
          Button("Reconnect") { model.reconnect() }
            .accessibilityIdentifier("bridge.reconnect")
        }
        Section("Trusted targets") {
          NavigationLink {
            TrustedTargetsView(model: model)
          } label: {
            LabeledContent("Pre-approved sites", value: "\(model.trustedTargets.count)")
          }
          .accessibilityIdentifier("bridge.trusted-targets")
          Text(
            "Matching HTTPS targets can start without asking again. Session allowedOrigins still limits access."
          )
          .font(.footnote)
        }
        Section("Local data") {
          Button("Clear browsing data", role: .destructive) {
            Task { await model.clearWebsiteData() }
          }
          .accessibilityIdentifier("bridge.clear-data")
          Button("Forget pairing", role: .destructive) { model.forgetPairing() }
            .accessibilityIdentifier("bridge.forget-pairing")
        }
        Section {
          Text("Keep this app open. iOS backgrounding or locking ends the remote session.")
            .font(.footnote)
        }
      }
    }
  }

  private func approvalView(_ pending: PendingApproval) -> some View {
    let pathPrefix =
      pending.initialURL.bridgeSuggestedPathPrefixURL?.bridgePercentEncodedPath ?? "/"
    let originLabel = pending.initialURL.host ?? "origin"

    return ScrollView {
      VStack(alignment: .leading, spacing: 12) {
        Text("Remote session request").font(.headline)
          .accessibilityIdentifier("bridge.approval-heading")
        Text(pending.initialURL.absoluteString)
          .font(.system(.caption, design: .monospaced))
          .textSelection(.enabled)
        Text("Requested top-level origins:").font(.caption.bold())
        ForEach(pending.allowedOrigins, id: \.self) {
          Text($0).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
        }

        Button("Approve once") { model.approvePending() }
          .buttonStyle(.borderedProminent)
          .frame(maxWidth: .infinity)
          .accessibilityIdentifier("bridge.approve")

        Divider()
        Text("Always allow").font(.caption.bold())
        Text("Persistent options stay on this iPhone until you remove them.")
          .font(.caption)
          .foregroundStyle(.secondary)

        Button("This exact URL") { model.approvePendingPermanently(.exactURL) }
          .buttonStyle(.bordered)
          .frame(maxWidth: .infinity)
          .accessibilityIdentifier("bridge.approve-exact-url")
        Button("Path prefix: \(pathPrefix)") { model.approvePendingPermanently(.pathPrefix) }
          .buttonStyle(.bordered)
          .frame(maxWidth: .infinity)
          .accessibilityIdentifier("bridge.approve-path-prefix")
        Button("Origin: \(originLabel)") { model.approvePendingPermanently(.origin) }
          .buttonStyle(.bordered)
          .frame(maxWidth: .infinity)
          .accessibilityIdentifier("bridge.approve-origin")

        Text("Subdomains are not included. HTTPS never grants HTTP.")
          .font(.caption)
          .foregroundStyle(.secondary)

        Button("Reject", role: .destructive) { model.rejectPending() }
          .frame(maxWidth: .infinity)
          .accessibilityIdentifier("bridge.reject")
      }
      .padding()
    }
    .background(Color.orange.opacity(0.16))
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var browserToolbar: some View {
    HStack(spacing: 12) {
      Button {
        Task { _ = try? await browser.navigate(action: "back", url: nil) }
      } label: {
        Image(systemName: "chevron.left")
      }
      Button {
        Task { _ = try? await browser.navigate(action: "forward", url: nil) }
      } label: {
        Image(systemName: "chevron.right")
      }
      Button {
        Task { _ = try? await browser.navigate(action: "reload", url: nil) }
      } label: {
        Image(systemName: "arrow.clockwise")
      }
      VStack(alignment: .leading, spacing: 1) {
        Text(browser.currentURL?.host ?? "Loading…").font(.caption).lineLimit(1)
        if let rule = model.activeTrustedRule {
          Text("Trusted: \(rule.kind.title)")
            .font(.caption2)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
      }
      Spacer()
      Button("Stop", role: .destructive) { Task { await model.stopActiveSession() } }
        .accessibilityIdentifier("bridge.stop")
    }
    .padding(.horizontal)
    .padding(.vertical, 7)
    .background(Color.red.opacity(0.08))
  }
}

private struct TrustedTargetsView: View {
  @ObservedObject var model: AppModel
  @State private var showAdd = false

  var body: some View {
    List {
      Section {
        Text(
          "These rules only remove the repeated approval tap. They never expand a session beyond its requested allowedOrigins."
        )
        .font(.footnote)
      }

      Section("Rules") {
        if model.trustedTargets.isEmpty {
          ContentUnavailableView(
            "No Trusted Targets",
            systemImage: "checkmark.shield",
            description: Text("Add an HTTPS URL, path prefix, or origin you trust."))
        } else {
          ForEach(model.trustedTargets) { rule in
            NavigationLink {
              TrustedTargetDetailView(model: model, rule: rule)
            } label: {
              VStack(alignment: .leading, spacing: 3) {
                Text(rule.kind.title).font(.subheadline.bold())
                Text(rule.value)
                  .font(.system(.caption, design: .monospaced))
                  .foregroundStyle(.secondary)
                  .lineLimit(2)
              }
            }
          }
        }
      }
    }
    .navigationTitle("Trusted Targets")
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Button {
          showAdd = true
        } label: {
          Label("Add", systemImage: "plus")
        }
        .accessibilityIdentifier("bridge.trusted-target-add")
      }
    }
    .sheet(isPresented: $showAdd) {
      NavigationStack {
        AddTrustedTargetView(model: model)
      }
    }
  }
}

private struct TrustedTargetDetailView: View {
  @ObservedObject var model: AppModel
  let rule: TrustedTargetRule
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    List {
      Section("Rule") {
        LabeledContent("Type", value: rule.kind.title)
        Text(rule.value)
          .font(.system(.caption, design: .monospaced))
          .textSelection(.enabled)
      }

      Section("Scope") {
        Text(rule.kind.explanation)
        Text("HTTPS only. HTTP is not equivalent.")
        Text("Subdomains are not included automatically.")
        if rule.kind == .pathPrefix {
          Text("Path matching uses boundaries, so /foo never authorizes /foobar.")
        }
      }

      Section {
        Button("Remove Rule", role: .destructive) {
          model.removeTrustedTarget(rule)
          dismiss()
        }
        .accessibilityIdentifier("bridge.trusted-target-remove")
      }
    }
    .navigationTitle("Trusted Target")
  }
}

private struct AddTrustedTargetView: View {
  @ObservedObject var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var urlText = ""
  @State private var kind: TrustedTargetKind = .exactURL
  @State private var errorText: String?

  private var preview: TrustedTargetRule? {
    let trimmed = urlText.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let url = URL(string: trimmed), !trimmed.isEmpty else { return nil }
    return try? TrustedTargetRule.make(kind: kind, url: url)
  }

  var body: some View {
    Form {
      Section("URL") {
        TextField("https://example.com/qa/", text: $urlText)
          .keyboardType(.URL)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .accessibilityIdentifier("bridge.trusted-target-url")
      }

      Section("Trust") {
        Picker("Scope", selection: $kind) {
          ForEach(TrustedTargetKind.allCases) { kind in
            VStack(alignment: .leading) {
              Text(kind.title)
              Text(kind.explanation).font(.caption)
            }
            .tag(kind)
          }
        }
        .pickerStyle(.inline)
        .labelsHidden()
      }

      if let preview {
        Section("Will allow") {
          Text(preview.value)
            .font(.system(.caption, design: .monospaced))
          Text(preview.kind.explanation).font(.footnote)
        }
      }

      Section("Safety") {
        Text("Subdomains are not included unless separately approved.")
        Text("HTTPS does not trust HTTP.")
        if kind == .pathPrefix {
          Text("Path boundaries are enforced: /foo does not include /foobar.")
        }
      }
      .font(.footnote)

      if let errorText {
        Section {
          Text(errorText).foregroundStyle(.red)
        }
      }
    }
    .navigationTitle("Add Trusted Target")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .cancellationAction) {
        Button("Cancel") { dismiss() }
      }
      ToolbarItem(placement: .confirmationAction) {
        Button("Add") {
          do {
            try model.addTrustedTarget(urlText: urlText, kind: kind)
            dismiss()
          } catch {
            errorText = (error as? BridgeError)?.message ?? error.localizedDescription
          }
        }
        .disabled(preview == nil)
        .accessibilityIdentifier("bridge.trusted-target-save")
      }
    }
  }
}
