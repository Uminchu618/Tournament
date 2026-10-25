"""Rebuild the bundled static Japanese font; runtime builds do not require Python."""
from pathlib import Path
from urllib.request import urlopen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

Path('.artifacts').mkdir(exist_ok=True)
source=Path('.artifacts/NotoSansJP-variable.ttf')
with urlopen('https://raw.githubusercontent.com/google/fonts/main/ofl/notosansjp/NotoSansJP%5Bwght%5D.ttf',timeout=60) as response:
    source.write_bytes(response.read())
font=instantiateVariableFont(TTFont(source),{'wght':400},inplace=True)
Path('assets/fonts').mkdir(parents=True,exist_ok=True)
font.save('assets/fonts/NotoSansJP-Regular.ttf')
with urlopen('https://raw.githubusercontent.com/google/fonts/main/ofl/notosansjp/OFL.txt',timeout=30) as response:
    Path('assets/fonts/LICENSE.txt').write_bytes(response.read())
print('日本語フォントを再生成しました')
