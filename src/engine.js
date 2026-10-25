/** Pure single-elimination engine. All geometry is in millimetres. No DOM dependencies. */
export const PAGE = Object.freeze({width:210,height:297,margin:10});
const powerOfTwo = n => 2 ** Math.ceil(Math.log2(n));
const escapeXML = s => String(s).replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));
const entrantLabel = entry => entry ? [entry.organization,entry.name].filter(Boolean).join(' ') : '';

/** Every bracket position is assigned by the organizer. null denotes an empty position. */
export function createTournament(entries, results = {}, slotIds) {
  if (!Array.isArray(entries) || entries.length < 2 || entries.length > 64) throw new Error('参加者は2〜64名で指定してください');
  const normalized = entries.map((e,i) => typeof e === 'string' ? {id:`e${i+1}`,name:e} : {...e,id:e?.id ?? `e${i+1}`});
  if (normalized.some(e => typeof e.id !== 'string' || !e.id || typeof e.name !== 'string' || !e.name.trim())) throw new Error('参加者IDと名前が必要です');
  if (new Set(normalized.map(e=>e.id)).size !== normalized.length) throw new Error('参加者IDが重複しています');
  const size = powerOfTwo(entries.length);
  if (!Array.isArray(slotIds) || slotIds.length !== size) throw new Error(`${size}枠の組合せを指定してください`);
  const entryById = new Map(normalized.map(entry => [entry.id, entry]));
  const assigned = slotIds.filter(id => id !== null);
  if (assigned.some(id => !entryById.has(id)) || new Set(assigned).size !== assigned.length || assigned.length !== normalized.length) {
    throw new Error('すべての参加者を重複なく枠に割り当ててください');
  }
  const leaves = slotIds.map((id,i) => ({id:`slot-${i+1}`,depth:0,position:i+1,entrant:id === null ? null : entryById.get(id),winner:id === null ? null : entryById.get(id),memberCount:id === null ? 0 : 1,resolved:true}));
  const rounds = [leaves]; const matches = [];
  while(rounds.at(-1).length > 1) {
    const prev = rounds.at(-1), depth=rounds.length;
    const next=[];
    for(let i=0;i<prev.length;i+=2) {
      const children=[prev[i],prev[i+1]], id=`R${depth}-M${i/2+1}`;
      const ready=children.every(c=>c.resolved), players=children.map(c=>c.winner).filter(Boolean);
      const chosen=results[id];
      if(chosen !== undefined && (!ready || players.length !== 2 || !players.some(e=>e.id === chosen))) throw new Error(`無効な勝者指定: ${id}`);
      const winner=ready && players.length<=1 ? players[0] ?? null : chosen === undefined ? null : players.find(e=>e.id === chosen);
      const memberCount=children[0].memberCount+children[1].memberCount;
      const node={id,depth,children,winner,memberCount,resolved:ready && (players.length<=1 || chosen !== undefined),bye:children.some(c=>c.memberCount===0)};
      next.push(node);
      if (!node.bye) matches.push(node);
    }
    rounds.push(next);
  }
  if(Object.keys(results).some(id=>!matches.some(m=>m.id === id))) throw new Error('存在しない試合IDです');
  return {entries:normalized,slotIds:[...slotIds],size,rounds,matches,root:rounds.at(-1)[0]};
}

/** Partition only at complete subtree boundaries. Each match is owned by exactly one page. */
export function paginate(tournament, {slotsPerPage=16} = {}) {
  if(![8,16,32].includes(slotsPerPage)) throw new Error('1ページの枠数は8・16・32を指定してください');
  const pages=[], owners=new Map(); let frontier=tournament.rounds[0];
  while(frontier.length>1) {
    const next=[];
    for(let offset=0;offset<frontier.length;offset+=slotsPerPage) {
      const inputs=frontier.slice(offset,offset+slotsPerPage);
      const baseDepth=inputs[0].depth, endDepth=baseDepth+Math.log2(inputs.length);
      const root=tournament.rounds[endDepth][offset/inputs.length];
      if(root.memberCount===0) { next.push(root); continue; }
      const page={number:pages.length+1,inputs,root,baseDepth,endDepth,matches:[]};
      const visit=node=>{if(node.depth===baseDepth)return; node.children.forEach(visit); page.matches.push(node); owners.set(node.id,page.number);};
      visit(root); pages.push(page); next.push(root);
    }
    frontier=next;
  }
  for(const page of pages) {
    page.sources=page.inputs.map(n=>n.depth ? owners.get(n.id) : null);
    page.destination=page.root===tournament.root ? null : pages.find(p=>p.inputs.some(n=>n.id===page.root.id))?.number;
  }
  return pages;
}

/** Produces a backend-neutral display list. Use the exact same list for screen and print. */
export function layoutPage(page, pageCount, {title='トーナメント表',matchDetails={}} = {}) {
  const shapes=[];
  const text=(x,y,value,size=3.1,extra={})=>shapes.push({type:'text',x,y,value,size,...extra});
  const line=(x1,y1,x2,y2,extra={})=>shapes.push({type:'line',x1,y1,x2,y2,...extra});
  // Empty seed slots remain in the logical tree, but have no visible row or edge.
  const visibleInputs=page.inputs.filter(node=>node.memberCount>0);
  const nodes=new Map(), n=visibleInputs.length;
  const firstY=44, lastY=264, rowStep=n===1 ? 0 : Math.min(13,(lastY-firstY)/(n-1));
  const top=firstY+((lastY-firstY)-rowStep*(n-1))/2;
  const inputX=64, finalX=192, columns=page.endDepth-page.baseDepth, dx=(finalX-inputX)/columns;
  text(10,17,title,5,{bold:true,maxWidth:190});
  text(10,25,page.baseDepth===0 ? `出場者 ${n}名 ／ ブロック ${page.number}` : '各ブロックの勝ち上がり',3.2);
  text(200,25,`${page.number} / ${pageCount}`,3,{anchor:'end'});
  for(let r=1;r<=columns;r++) text(inputX+dx*r,35,`第${page.baseDepth+r}回戦`,2.8,{anchor:'end'});
  visibleInputs.forEach((node,i)=>{
    const y=top+i*rowStep;
    nodes.set(node.id,{x:inputX,y});
    const source=page.sources[page.inputs.indexOf(node)];
    const entry=node.depth?node.winner:node.entrant;
    const label=entry?.name ?? `${node.id} 勝者`;
    text(10,y-1,label,3.1,{maxWidth:51,muted:!node.winner});
    text(10,y+2.2,[entry?.organization,source ? `p.${source} / ${node.id}` : `枠 ${node.position}`,entry?.seed?`第${entry.seed}シード`:''].filter(Boolean).join(' ／ '),2.1,{muted:true,maxWidth:51});
    line(10,y+3.5,inputX,y+3.5,{light:true});
  });
  for(const node of page.matches) {
    const [a,b]=node.children.map(c=>nodes.get(c.id));
    // A walkover is not a played match. Alias its output to the entrant's
    // original coordinate so the next real match connects directly to them.
    if(!a || !b) {
      if(a || b) nodes.set(node.id,a ?? b);
      continue;
    }
    const x=inputX+dx*(node.depth-page.baseDepth), join=x-dx*.45, y=(a.y+b.y)/2;
    const matchId=node.id;
    line(a.x,a.y,join,a.y,{matchId}); line(b.x,b.y,join,b.y,{matchId}); line(join,a.y,join,b.y,{matchId}); line(join,y,x,y,{matchId,winner:!!node.winner});
    const detail=matchDetails[node.id];
    const score=detail?.scoreA!=null&&detail?.scoreB!=null?` ${detail.scoreA}–${detail.scoreB}`:'';
    text(x,y-1.4,`${node.winner?.name ?? node.id}${score}`,2.6,{matchId,anchor:'end',maxWidth:dx-2,muted:!node.winner});
    nodes.set(node.id,{x,y});
  }
  const footer=page.destination ? `${page.root.id} 勝者 → p.${page.destination}` : `優勝：${entrantLabel(page.root.winner)||'未確定'}`;
  text(10,280,footer,3.2,{bold:true,maxWidth:190});
  text(10,287,'A4 縦 / 100% / 余白なし・ブラウザーのヘッダーとフッターはオフ',2.3,{muted:true});
  return {width:PAGE.width,height:PAGE.height,pageNumber:page.number,shapes};
}

// Conservative truncation: full text remains available through SVG <title>.
export function truncate(value,maxWidth,size,measure) {
  if(!maxWidth)return value;
  const widthOf = c => measure?measure(c,size):/[\u0020-\u007e]/.test(c) ? size*.65 : size*1.05;
  if(Array.from(value).reduce((sum,c)=>sum+widthOf(c),0)<=maxWidth)return value;
  let used=0,out='';
  for(const c of Array.from(value)) {const width=widthOf(c); if(used+width>maxWidth-size*1.1)return out+'…'; out+=c;used+=width;}
  return out;
}
export function renderSVG(scene) {
  const body=scene.shapes.map(s=>s.type==='line'
    ? `<line x1="${s.x1}" y1="${s.y1}" x2="${s.x2}" y2="${s.y2}"${s.matchId ? ` data-match-id="${escapeXML(s.matchId)}"` : ''} stroke="${s.light?'#cbd5e1':s.winner?'#174b36':'#334155'}" stroke-width="${s.winner ? .45 : .22}"/>`
    : `<text x="${s.x}" y="${s.y}" font-size="${s.size}" text-anchor="${s.anchor??'start'}"${s.matchId ? ` data-match-id="${escapeXML(s.matchId)}"` : ''} fill="${s.muted?'#64748b':'#172a24'}"><title>${escapeXML(s.value)}</title>${escapeXML(s.displayValue??truncate(s.value,s.maxWidth,s.size))}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="210mm" height="297mm" viewBox="0 0 210 297" role="img" aria-label="トーナメント表 ${scene.pageNumber}ページ" style="font-family:'Tournament Noto','Noto Sans CJK JP','Yu Gothic',Meiryo,sans-serif"><rect width="210" height="297" fill="white"/>${body}</svg>`;
}
export function renderTournament(entries,{slotIds,results={},slotsPerPage=16,title,matchDetails={}}={}) {
  const tournament=createTournament(entries,results,slotIds), pages=paginate(tournament,{slotsPerPage});
  const scenes=pages.map(p=>layoutPage(p,pages.length,{title,matchDetails}));
  return {tournament,pages,scenes,svgs:scenes.map(renderSVG)};
}

/** Match annotations are continued onto A4 pages without truncating their content. */
export function documentScenes(document,{measure,label=''}={}) {
  const {tournament,scenes}=renderTournament(document.participants,{slotIds:document.slots,results:document.results,
    title:document.title,slotsPerPage:document.layoutSettings?.slotsPerPage??16,matchDetails:document.matchDetails});
  const chunks=[];
  const wrap=(text,width=188,size=3)=>{
    const lines=[];let line='';
    for(const char of String(text)) {
      if(char==='\n'){lines.push(line);line='';continue;}
      const trial=line+char;
      const length=measure?measure(trial,size):Array.from(trial).reduce((sum,c)=>sum+(/[\u0020-\u007e]/.test(c)?size*.65:size*1.05),0);
      if(line&&length>width){lines.push(line);line=char;}else line=trial;
    }
    if(line)lines.push(line);
    return lines;
  };
  if(document.date) chunks.push(...wrap(`開催 ${document.date}`));
  if(document.notes) chunks.push(...wrap(document.notes));
  for(const match of tournament.matches) {
    const detail=document.matchDetails?.[match.id];
    if(!detail||![detail.venue,detail.scheduledAt,detail.notes,detail.scoreA!=null].some(Boolean))continue;
    const names=match.children.map(c=>entrantLabel(c.winner)||`${c.id} 勝者`);
    chunks.push('',...wrap(`${match.id}　${names.join(' 対 ')}`));
    const score=detail.scoreA!=null?`${detail.scoreA} 対 ${detail.scoreB}`:'';
    const date=detail.scheduledAt?new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',dateStyle:'medium',timeStyle:'short'}).format(new Date(detail.scheduledAt)):'';
    chunks.push(...wrap([date,detail.venue,score,match.winner?`勝者 ${entrantLabel(match.winner)}`:''].filter(Boolean).join(' ／ ')));
    if(detail.notes)chunks.push(...wrap(detail.notes));
  }
  while(chunks.length) {
    const rows=chunks.splice(0,47),pageNumber=scenes.length+1;
    scenes.push({width:210,height:297,pageNumber,shapes:[
      {type:'text',x:10,y:17,value:`${document.title} — 試合情報`,size:4,maxWidth:190},
      ...rows.map((value,i)=>({type:'text',x:10,y:33+i*5,value,size:3})),
    ]});
  }
  for(const scene of scenes) {
    scene.shapes=scene.shapes.filter(shape=>!(shape.type==='text'&&shape.y===287&&shape.value.includes('ブラウザー')));
    for(const shape of scene.shapes)if(shape.type==='text'&&shape.x===200&&shape.y===25)shape.value=`${scene.pageNumber} / ${scenes.length}`;
    scene.shapes.push({type:'text',x:200,y:292,value:`${label} ${scene.pageNumber}/${scenes.length}`.trim(),size:2.2,anchor:'end',maxWidth:190});
    for(const shape of scene.shapes) if(shape.type==='text') shape.displayValue=truncate(shape.value,shape.maxWidth,shape.size,measure);
  }
  return scenes;
}
