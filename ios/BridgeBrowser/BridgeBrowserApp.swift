import SwiftUI

@main
struct BridgeBrowserApp: App {
  @StateObject private var model = AppModel()
  @Environment(\.scenePhase) private var scenePhase

  var body: some Scene {
    WindowGroup {
      ContentView(model: model)
        .onAppear { model.enterForeground() }
        .onChange(of: scenePhase) { _, phase in
          switch phase {
          case .active: model.enterForeground()
          case .inactive, .background: Task { await model.leaveForeground() }
          @unknown default: Task { await model.leaveForeground() }
          }
        }
    }
  }
}
