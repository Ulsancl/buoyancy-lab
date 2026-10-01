"""Draw the original Buoyancy Lab icon. Pillow is a build-time tool only."""
from pathlib import Path
from PIL import Image, ImageDraw

output = Path(__file__).resolve().parent.parent / 'resources'
output.mkdir(exist_ok=True)
image = Image.new('RGBA', (512, 512), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((9, 9, 503, 503), radius=100, fill='#102335', outline='#365c70', width=8)
# A finite transparent tank, a partly submerged block, and an upward force.
draw.rounded_rectangle((78, 157, 435, 418), radius=12, fill='#173e55')
draw.rectangle((87, 265, 426, 407), fill='#258fae')
draw.rectangle((199, 184, 318, 327), fill='#f3bf70', outline='#ffe0a0', width=7)
draw.rectangle((206, 267, 311, 319), fill='#c88f50')
draw.line([(78, 147), (78, 418), (435, 418), (435, 147)], fill='#9dcbdc', width=10, joint='curve')
draw.line([(88, 265), (192, 265)], fill='#7fe0ed', width=7)
draw.line([(325, 265), (425, 265)], fill='#7fe0ed', width=7)
draw.line([(258, 168), (258, 87)], fill='#c8f7ff', width=12)
draw.polygon([(235, 111), (258, 77), (281, 111)], fill='#c8f7ff')
for y in (198, 230, 265, 300, 336, 373):
    draw.line((94, y, 114, y), fill='#95cbd9', width=4)
draw.rounded_rectangle((172, 445, 340, 455), radius=5, fill='#547c90')
image.save(output / 'app.png')
image.save(output / 'app.ico', sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
print('Created Buoyancy Lab resources/app.png and app.ico')
