#!/bin/sh
# Prints the name of the node's USB NIC, the capture interface, and waits
# until one is plugged in. The pod shares the node's network namespace, so
# /sys/class/net lists the node's links; a USB link's device path runs through
# a usb bus.
while :; do
  for dir in /sys/class/net/*; do
    case "$(readlink -f "$dir/device" 2>/dev/null)" in
      */usb*) basename "$dir"; exit 0 ;;
    esac
  done
  echo "sensor: waiting for a USB NIC on $(hostname)" >&2
  sleep 15
done
