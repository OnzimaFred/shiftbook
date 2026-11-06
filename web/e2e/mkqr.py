# Writes a short MJPEG (Chrome fake camera) showing a QR code of argv[1] on a white 640x480 frame.
import sys, io, qrcode
from PIL import Image
img = qrcode.make(sys.argv[1], box_size=8, border=4).convert("RGB")
frame = Image.new("RGB", (640, 480), "white")
img.thumbnail((440, 440)); frame.paste(img, ((640 - img.width) // 2, (480 - img.height) // 2))
buf = io.BytesIO(); frame.save(buf, "JPEG", quality=90)
open(sys.argv[2], "wb").write(buf.getvalue() * 30)
