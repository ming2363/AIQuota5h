import AppKit

let image = NSImage(size: NSSize(width: 1024, height: 1024))
image.lockFocus()
let background = NSBezierPath(roundedRect: NSRect(x: 38, y: 38, width: 948, height: 948), xRadius: 218, yRadius: 218)
NSGradient(starting: NSColor(red: 0.13, green: 0.37, blue: 0.94, alpha: 1), ending: NSColor(red: 0.18, green: 0.65, blue: 0.95, alpha: 1))!.draw(in: background, angle: 50)
let track = NSBezierPath()
track.appendArc(withCenter: NSPoint(x: 512, y: 480), radius: 300, startAngle: 215, endAngle: -35, clockwise: true)
track.lineWidth = 54
track.lineCapStyle = .round
NSColor.white.withAlphaComponent(0.25).setStroke()
track.stroke()
let arc = NSBezierPath()
arc.appendArc(withCenter: NSPoint(x: 512, y: 480), radius: 300, startAngle: 215, endAngle: 50, clockwise: true)
arc.lineWidth = 54
arc.lineCapStyle = .round
NSColor.white.setStroke()
arc.stroke()
for (x, height) in [(362.0, 115.0), (478.0, 185.0), (594.0, 265.0)] {
    NSColor.white.setFill()
    NSBezierPath(roundedRect: NSRect(x: x, y: 315, width: 68, height: height), xRadius: 20, yRadius: 20).fill()
}
image.unlockFocus()
let rep = NSBitmapImageRep(data: image.tiffRepresentation!)!
try rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
