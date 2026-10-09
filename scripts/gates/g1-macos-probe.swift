// The macOS half of the G1 gate (scripts/gates/g1-shell.ts), built once per run with
// `swiftc -O -o <work>/g1-macos-probe g1-macos-probe.swift`. Each subcommand prints one JSON value.
//
//   trust                  what this process may do: Accessibility, Screen Recording, posting events
//   apps <bundle id>       the running apps with that bundle id: pid, bundle path, active
//   windows                every on-screen window: id, owner pid, layer, owner name, title (null when
//                          macOS hides it, which it does for other apps without Screen Recording)
//   extras <pid> [pid...]  each app's status items and where they sit, read from its Accessibility tree
//                          (AXExtrasMenuBar). On macOS 26 the item windows belong to Control Center,
//                          not to the app, so the window list cannot tell whose an item is
//   front                  the frontmost app's pid and bundle id
//   hotkey                 Option+Command+R, akou's macOS default, as real key events at the HID level
//
// A probe that is not allowed to look says so (`error`), so a missing grant never reads as "none".

import AppKit
import ApplicationServices
import CoreGraphics

func emit(_ value: Any) {
  let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
  print(String(data: data, encoding: .utf8)!)
}

func axString(_ el: AXUIElement, _ attr: String) -> String? {
  var v: CFTypeRef?
  guard AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success else { return nil }
  return v as? String
}

/** An element's frame in screen points (top-left origin), the way `screencapture -R` takes it. */
func axFrame(_ el: AXUIElement) -> Any {
  var p: CFTypeRef?
  var z: CFTypeRef?
  var point = CGPoint.zero
  var size = CGSize.zero
  guard AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &p) == .success,
    AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &z) == .success,
    AXValueGetValue(p as! AXValue, .cgPoint, &point),
    AXValueGetValue(z as! AXValue, .cgSize, &size)
  else { return NSNull() }
  return ["x": Int(point.x), "y": Int(point.y), "w": Int(size.width), "h": Int(size.height)]
}

let args = Array(CommandLine.arguments.dropFirst())
switch args.first ?? "" {
case "trust":
  emit([
    "accessibility": AXIsProcessTrusted(),
    "screenRecording": CGPreflightScreenCaptureAccess(),
    "postEvent": CGPreflightPostEventAccess(),
  ])

case "apps":
  let id = args.count > 1 ? args[1] : ""
  emit(
    NSWorkspace.shared.runningApplications
      .filter { $0.bundleIdentifier == id }
      .map {
        [
          "pid": Int($0.processIdentifier),
          // As LaunchServices has it; resolvingSymlinksInPath would drop /private from
          // /private/var/folders, so the gate canonicalizes both sides itself.
          "path": $0.bundleURL?.path ?? NSNull(),
          "active": $0.isActive,
        ] as [String: Any]
      })

case "windows":
  let list =
    CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
  emit(
    list.map {
      [
        "id": $0[kCGWindowNumber as String] as? Int ?? -1,
        "pid": $0[kCGWindowOwnerPID as String] as? Int ?? -1,
        "layer": $0[kCGWindowLayer as String] as? Int ?? -1,
        "owner": $0[kCGWindowOwnerName as String] as? String ?? NSNull(),
        "title": $0[kCGWindowName as String] as? String ?? NSNull(),
      ] as [String: Any]
    })

case "extras":
  var out: [[String: Any]] = []
  for arg in args.dropFirst() {
    guard let pid = Int32(arg) else { continue }
    var row: [String: Any] = ["pid": Int(pid)]
    var bar: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(
      AXUIElementCreateApplication(pid), "AXExtrasMenuBar" as CFString, &bar)
    if err == .success, let bar {
      var kids: CFTypeRef?
      AXUIElementCopyAttributeValue(bar as! AXUIElement, kAXChildrenAttribute as CFString, &kids)
      row["items"] = ((kids as? [AXUIElement]) ?? []).map {
        [
          "role": axString($0, kAXRoleAttribute) ?? NSNull(),
          "title": axString($0, kAXTitleAttribute) ?? NSNull(),
          "description": axString($0, kAXDescriptionAttribute) ?? NSNull(),
          "frame": axFrame($0),
        ] as [String: Any]
      }
    } else if err == .noValue || err == .attributeUnsupported {
      // An app with no status item has no extras menu bar.
      row["items"] = [] as [Any]
    } else {
      row["error"] = "AXError \(err.rawValue)"
    }
    out.append(row)
  }
  emit(out)

case "front":
  let app = NSWorkspace.shared.frontmostApplication
  emit([
    "pid": Int(app?.processIdentifier ?? -1), "bundleId": app?.bundleIdentifier ?? NSNull(),
  ] as [String: Any])

case "hotkey":
  // Option, Command, R (virtual key 15) down, then up in reverse order, each carrying the flags a
  // real keyboard would set at that moment.
  let src = CGEventSource(stateID: .hidSystemState)
  let option: CGKeyCode = 58
  let command: CGKeyCode = 55
  let r: CGKeyCode = 15
  let both: CGEventFlags = [.maskAlternate, .maskCommand]
  let steps: [(CGKeyCode, Bool, CGEventFlags)] = [
    (option, true, [.maskAlternate]), (command, true, both), (r, true, both),
    (r, false, both), (command, false, [.maskAlternate]), (option, false, []),
  ]
  for (key, down, flags) in steps {
    let ev = CGEvent(keyboardEventSource: src, virtualKey: key, keyDown: down)!
    ev.flags = flags
    ev.post(tap: .cghidEventTap)
    usleep(40_000)
  }
  emit(["posted": true, "postEvent": CGPreflightPostEventAccess()])

default:
  FileHandle.standardError.write("usage: g1-macos-probe trust|apps|windows|extras|front|hotkey\n".data(using: .utf8)!)
  exit(2)
}
