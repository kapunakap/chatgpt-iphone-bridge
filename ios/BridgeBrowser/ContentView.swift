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
        statusBar
        if model.credentials == nil { pairingView } else { pairedView }
      }
      .navigationTitle("Bridge Browser")
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
    VStack(alignment: .leading, spacing: 10) {
      Text("Remote session request").font(.headline)
        .accessibilityIdentifier("bridge.approval-heading")
      Text(pending.initialURL.absoluteString).font(.caption).textSelection(.enabled)
      Text("Approved top-level origins:").font(.caption.bold())
      ForEach(pending.allowedOrigins, id: \.self) {
        Text($0).font(.caption).textSelection(.enabled)
      }
      HStack {
        Button("Reject", role: .destructive) { model.rejectPending() }
          .accessibilityIdentifier("bridge.reject")
        Spacer()
        Button("Approve") { model.approvePending() }.buttonStyle(.borderedProminent)
          .accessibilityIdentifier("bridge.approve")
      }
    }
    .padding()
    .background(Color.orange.opacity(0.16))
  }

  private var browserToolbar: some View {
    HStack {
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
      Text(browser.currentURL?.host ?? "Loading…").font(.caption).lineLimit(1)
      Spacer()
      Button("Stop", role: .destructive) { Task { await model.stopActiveSession() } }
        .accessibilityIdentifier("bridge.stop")
    }
    .padding(.horizontal)
    .padding(.vertical, 7)
    .background(Color.red.opacity(0.08))
  }
}
