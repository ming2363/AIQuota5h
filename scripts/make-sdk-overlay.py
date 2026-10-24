#!/usr/bin/env python3
"""Local compatibility overlay for the known CLT Swift 6.2.4 / SDK 6.2.3 mismatch.

Never edits the system SDK. Other compiler/SDK pairs should use matching Xcode tools.
"""
import json
import os
from pathlib import Path
import subprocess
import sys

sdk = Path(sys.argv[1]).resolve()
out = Path(sys.argv[2]).resolve()
interfaces = out / "ifaces"
interfaces.mkdir(parents=True, exist_ok=True)
roots = []
seen = set()
stack = [sdk]
while stack:
    directory = stack.pop()
    real = directory.resolve()
    if real in seen:
        continue
    seen.add(real)
    try:
        entries = list(directory.iterdir())
    except OSError:
        continue
    stack.extend(p for p in entries if p.is_dir())
    if not any(p.name.endswith(".swiftinterface") for p in entries):
        continue
    contents = []
    for source in entries:
        if source.is_dir():
            continue
        target = source
        if source.name.endswith(".swiftinterface"):
            target = interfaces / str(source).replace("/", "_")
            text = source.read_text(errors="replace")
            text = text.replace("swiftlang-6.2.3.3.2 clang-1700.6.3.2", "swiftlang-6.2.4.1.4 clang-1700.6.4.2")
            text = text.replace("Apple Swift version 6.2 effective-5.10", "Apple Swift version 6.2.4 effective-5.10")
            target.write_text(text)
        contents.append({"type": "file", "name": source.name, "external-contents": str(target)})
    roots.append({"type": "directory", "name": str(directory), "contents": contents})
include = Path(subprocess.check_output(["xcrun", "--find", "swiftc"], text=True).strip()).parent.parent / "include/swift"
empty = out / "empty.modulemap"
empty.write_text("// SwiftBridging is already provided by bridging.modulemap\n")
roots.append({"type": "directory", "name": str(include), "contents": [
    {"type": "file", "name": "module.modulemap", "external-contents": str(empty)},
    {"type": "file", "name": "bridging.modulemap", "external-contents": str(include / "bridging.modulemap")},
    {"type": "file", "name": "bridging", "external-contents": str(include / "bridging")},
]})
(out / "overlay.yaml").write_text(json.dumps({"version": 0, "roots": roots}))
print("使用本地 SDK 兼容层；系统 SDK 未修改。")
