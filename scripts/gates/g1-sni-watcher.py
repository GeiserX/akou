"""A StatusNotifierWatcher for the G1 gate (scripts/gates/g1-shell.ts) on Linux.

KDE Plasma and GNOME's AppIndicator extension each run one of these: a tray item, ElectroBun's
Ayatana AppIndicator included, registers with it on the session bus. This one says a host is
there (or the indicator would fall back to an XEmbed icon), records every registration as a JSON
line in the file named by its argument, and prints "ready" once it owns its bus name.
"""

import json
import sys

from gi.repository import Gio, GLib

XML = """
<node>
  <interface name="org.kde.StatusNotifierWatcher">
    <method name="RegisterStatusNotifierItem"><arg name="service" type="s" direction="in"/></method>
    <method name="RegisterStatusNotifierHost"><arg name="service" type="s" direction="in"/></method>
    <property name="RegisteredStatusNotifierItems" type="as" access="read"/>
    <property name="IsStatusNotifierHostRegistered" type="b" access="read"/>
    <property name="ProtocolVersion" type="i" access="read"/>
    <signal name="StatusNotifierItemRegistered"><arg type="s"/></signal>
    <signal name="StatusNotifierItemUnregistered"><arg type="s"/></signal>
    <signal name="StatusNotifierHostRegistered"/>
  </interface>
</node>
"""
PATH = "/StatusNotifierWatcher"
IFACE = "org.kde.StatusNotifierWatcher"

log = open(sys.argv[1], "a", buffering=1)
items = []
info = Gio.DBusNodeInfo.new_for_xml(XML).interfaces[0]


def on_call(conn, sender, path, iface, method, params, invocation):
    if method == "RegisterStatusNotifierItem":
        service = params.unpack()[0]
        item = sender + service if service.startswith("/") else service
        items.append(item)
        log.write(json.dumps({"sender": sender, "service": service}) + "\n")
        conn.emit_signal(None, PATH, IFACE, "StatusNotifierItemRegistered", GLib.Variant("(s)", (item,)))
    invocation.return_value(None)


def on_get(conn, sender, path, iface, prop):
    if prop == "RegisteredStatusNotifierItems":
        return GLib.Variant("as", items)
    if prop == "IsStatusNotifierHostRegistered":
        return GLib.Variant("b", True)
    return GLib.Variant("i", 0)


def on_bus(conn, name):
    conn.register_object(PATH, info, on_call, on_get, None)


def on_name(conn, name):
    print("ready", flush=True)


def on_lost(conn, name):
    print("lost the name " + name, file=sys.stderr, flush=True)
    sys.exit(2)


Gio.bus_own_name(Gio.BusType.SESSION, IFACE, Gio.BusNameOwnerFlags.NONE, on_bus, on_name, on_lost)
GLib.MainLoop().run()
