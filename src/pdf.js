import {PDFDocument,rgb} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

let loaded;
export function loadFont() {
  return loaded??=(async()=>{
    const response=await fetch('/assets/fonts/NotoSansJP-Regular.ttf',{cache:'no-store'});
    if(!response.ok)throw new Error('PDF用の日本語フォントを読み込めませんでした');
    const bytes=new Uint8Array(await response.arrayBuffer());
    const font=fontkit.create(bytes);
    const measure=(text,size)=>font.layout(String(text)).positions.reduce((sum,p)=>sum+p.xAdvance,0)*size/font.unitsPerEm;
    const face=new FontFace('Tournament Noto',bytes);
    document.fonts.add(await face.load());
    return {bytes,measure,font};
  })().catch(error=>{loaded=undefined;throw error;});
}

export async function createPDF(scenes,{title,revision}) {
  const {bytes,font}=await loadFont();
  const pdf=await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  // The current fontkit subsetter drops some Japanese glyphs. Embed the static
  // TrueType font intact, and verify the rendered PDF as well as extracted text.
  const embedded=await pdf.embedFont(bytes,{subset:false});
  pdf.setTitle(title);pdf.setSubject(`大会データ版 ${revision}`);pdf.setCreator('Tournament');
  const pt=72/25.4;
  for(const scene of scenes) {
    const page=pdf.addPage([scene.width*pt,scene.height*pt]);
    for(const shape of scene.shapes) {
      if(shape.type==='line') {
        page.drawLine({start:{x:shape.x1*pt,y:(scene.height-shape.y1)*pt},end:{x:shape.x2*pt,y:(scene.height-shape.y2)*pt},
          thickness:(shape.winner?.45:.22)*pt,color:shape.light?rgb(.8,.84,.82):shape.winner?rgb(.09,.29,.21):rgb(.2,.25,.33)});
      } else {
        const text=shape.displayValue??shape.value;
        if(!text)continue;
        for(const char of text) if(!/\s/.test(char)&&!font.hasGlyphForCodePoint(char.codePointAt(0))) throw new Error('日本語フォントで表示できない文字が含まれています。参加者名・注記を確認してください');
        const size=shape.size*pt,width=embedded.widthOfTextAtSize(text,size);
        const x=shape.x*pt-(shape.anchor==='end'?width:shape.anchor==='middle'?width/2:0);
        page.drawText(text,{x,y:(scene.height-shape.y)*pt,size,font:embedded,color:shape.muted?rgb(.39,.45,.55):rgb(.09,.16,.14)});
      }
    }
  }
  return new Uint8Array(await pdf.save());
}
