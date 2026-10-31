import CoreGraphics
import Foundation
var seen: [String] = []
let mask = (1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.keyUp.rawValue)
  | (1 << CGEventType.flagsChanged.rawValue)
let callback: CGEventTapCallBack = { _, type, event, _ in
  let code = event.getIntegerValueField(.keyboardEventKeycode)
  let kind = type == .keyDown ? "down" : type == .keyUp ? "up" : "flags"
  seen.append("\(kind):\(code)")
  return Unmanaged.passUnretained(event)
}
guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .tailAppendEventTap,
  options: .defaultTap, eventsOfInterest: CGEventMask(mask), callback: callback, userInfo: nil)
else { print("no tap"); exit(2) }
CFRunLoopAddSource(CFRunLoopGetCurrent(), CFMachPortCreateRunLoopSource(nil, tap, 0), .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)
let source = CGEventSource(stateID: .hidSystemState)
func pump(_ s: Double) { CFRunLoopRunInMode(.defaultMode, s, false) }
func post(_ code: CGKeyCode, _ down: Bool, _ flags: UInt64, modifier: Bool = false) {
  let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)!
  if modifier { e.type = .flagsChanged }
  e.flags = CGEventFlags(rawValue: flags)
  e.post(tap: .cghidEventTap)
  pump(0.05)
}
let ctl: UInt64 = 0x40000 | 0x1, sh: UInt64 = 0x20000 | 0x2
post(59, true, ctl, modifier: true)
post(56, true, ctl | sh, modifier: true)
post(49, true, ctl | sh)
post(49, false, ctl | sh)
post(56, false, ctl, modifier: true)
post(59, false, 0, modifier: true)
post(0, true, 0)
post(0, false, 0)
pump(0.3)
print(seen.joined(separator: " "))
