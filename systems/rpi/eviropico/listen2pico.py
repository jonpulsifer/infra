import sys, time
from threading import Thread, Event

try:
    import pyboard
except ImportError:
    print("Error: can't import pyboard module.")
    print("Maybe pyserial package is not installed. You can install it using:")
    print("  python.exe -m pip install pyserial")
    sys.exit(2)

def read_serial_port(pyb: pyboard.Pyboard, stop_event: Event):
    while not stop_event.is_set():
        try:
            n = pyb.serial.inWaiting()
        except OSError as er:
            if er.args[0] == 5:  # IO error, device disappeared
                print("Device disconnected!")
                break

        if n > 0:
            c = pyb.serial.read(1)
            if c is not None:
                # pass character through to the console
                oc = ord(c)
                if oc in (8, 9, 10, 13, 27) or 32 <= oc <= 126:
                    sys.stdout.write(c.decode("utf-8"))
                    sys.stdout.flush()
                else:
                    sys.stdout.write((b"[%02x]" % ord(c)).decode("utf-8"))
                    sys.stdout.flush()

        # Add a small delay to reduce CPU usage
        time.sleep(0.01)

def main(dev: str):
    # Create a pyboard instance
    pyb = pyboard.Pyboard(dev, baudrate=115200, exclusive=True)
    stop_event = Event()
    serial_thread = Thread(target=read_serial_port, args=(pyb, stop_event,))
    serial_thread.daemon = True
    try:
        print("Connecting to pyboard; press Ctrl-C to exit...")
        serial_thread.start()
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        stop_event.set()
        print("\nExiting, joining threads...")
        serial_thread.join()
        print("Done.")
        sys.exit(0)


if __name__ == "__main__":
    if len(sys.argv) == 2:
        main(sys.argv[1])
    else:
        print("Usage: python3 listen2pico.py <port>")
        sys.exit(1)
