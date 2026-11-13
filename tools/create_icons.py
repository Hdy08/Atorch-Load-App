"""Generate the code-drawn project icon; no external artwork required."""
from pathlib import Path
from PIL import Image, ImageDraw
p=Path('apps/app/src-tauri/icons');p.mkdir(parents=True,exist_ok=True)
im=Image.new('RGBA',(512,512),(0,0,0,0));d=ImageDraw.Draw(im)
d.rounded_rectangle((8,8,504,504),radius=120,fill='#f4813b')
d.polygon([(278,82),(155,281),(239,281),(215,430),(368,218),(278,218)],fill='white')
im.save(p/'icon.png');im.save(p/'icon.ico',sizes=[(16,16),(32,32),(48,48),(64,64),(128,128),(256,256)])
for size in [32,128,256]:im.resize((size,size)).save(p/f'{size}x{size}.png')
