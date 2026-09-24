#!/usr/bin/env bash
# Virtual audio devices for the live capture test (tests/capture-live.e2e.test.ts) on a headless
# Linux machine: a call output that becomes the default sink, a virtual microphone that becomes
# the default source, and a way to play the test stimulus into them.
#
#   scripts/capture-rig.sh pipewire     PipeWire, WirePlumber and pipewire-pulse. A stimulus sink
#                                       whose left channel is linked port to port into the mic and
#                                       whose right channel into the call output, in one graph, so
#                                       both tones start on the same sample: play with
#                                       `paplay --device=akou_stim "$STIM"`.
#   scripts/capture-rig.sh pulseaudio   PulseAudio. The mic is a remap of a second null sink's
#                                       monitor; the two tones need two players, which start a few
#                                       milliseconds apart: play with
#                                       `paplay -d akou_micbus "$STIM_MIC" & paplay -d akou_call "$STIM_CALL"; wait`.
#
# Needs XDG_RUNTIME_DIR (created here when missing) and the server's packages installed. Starts a
# session D-Bus when none is running. For CI and throwaway containers: it takes over the user's
# sound server.
set -euo pipefail

mode=${1:?usage: capture-rig.sh pipewire|pulseaudio}
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/tmp/akou-rig-$(id -u)}
mkdir -p -m 700 "$XDG_RUNTIME_DIR"
logs=${RIG_LOGS:-$XDG_RUNTIME_DIR}

wait_for() {
  for _ in $(seq 1 100); do
    if eval "$1" >/dev/null 2>&1; then return 0; fi
    sleep 0.1
  done
  echo "capture-rig: timed out waiting for: $1" >&2
  return 1
}

if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
  dbus-daemon --session --fork --address="unix:path=$XDG_RUNTIME_DIR/bus"
  export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
fi

case "$mode" in
  pipewire)
    pipewire >"$logs/pipewire.log" 2>&1 &
    wait_for "pw-cli info 0"
    wireplumber >"$logs/wireplumber.log" 2>&1 &
    pipewire-pulse >"$logs/pipewire-pulse.log" 2>&1 &
    wait_for "pactl info"
    node() {
      pw-cli create-node adapter "{ factory.name=support.null-audio-sink node.name=$1 node.description=$1 media.class=$2 object.linger=true audio.position=[FL FR] }" >/dev/null
    }
    node akou_call Audio/Sink
    node akou_mic Audio/Source/Virtual
    node akou_stim Audio/Sink
    wait_for "pw-link -o | grep -q akou_stim:monitor_FR && pw-link -i | grep -q akou_mic:input_FR && pw-link -i | grep -q akou_call:playback_FR"
    pw-link akou_stim:monitor_FL akou_mic:input_FL
    pw-link akou_stim:monitor_FL akou_mic:input_FR
    pw-link akou_stim:monitor_FR akou_call:playback_FL
    pw-link akou_stim:monitor_FR akou_call:playback_FR
    wait_for "pactl list short sinks | grep -q akou_call && pactl list short sources | grep -q akou_mic"
    ;;
  pulseaudio)
    pulseaudio --daemonize=yes --exit-idle-time=-1 --log-target=file:"$logs/pulseaudio.log"
    wait_for "pactl info"
    pactl load-module module-null-sink sink_name=akou_call sink_properties=device.description=akou_call >/dev/null
    pactl load-module module-null-sink sink_name=akou_micbus sink_properties=device.description=akou_micbus >/dev/null
    pactl load-module module-remap-source source_name=akou_mic master=akou_micbus.monitor source_properties=device.description=akou_mic >/dev/null
    ;;
  *)
    echo "capture-rig: unknown mode $mode" >&2
    exit 64
    ;;
esac

pactl set-default-sink akou_call
pactl set-default-source akou_mic
pactl info | grep -E '^(Server Name|Default Sink|Default Source)'
echo "XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR"
echo "DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS"
