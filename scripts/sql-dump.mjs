/** Split the application's SQLite dump without splitting strings or comments. */
export function splitStatements(source){
  const statements=[];let quote=null,lineComment=false,blockComment=false,start=0;
  for(let i=0;i<source.length;i++){
    const char=source[i],next=source[i+1];
    if(lineComment){if(char==='\n')lineComment=false;continue;}
    if(blockComment){if(char==='*'&&next==='/'){blockComment=false;i++;}continue;}
    if(quote){if(char===quote){if(next===quote)i++;else quote=null;}continue;}
    if(char==='-'&&next==='-'){lineComment=true;i++;continue;}
    if(char==='/'&&next==='*'){blockComment=true;i++;continue;}
    if(char==="'"||char==='"'||char==='`'){quote=char;continue;}
    if(char==='['){quote=']';continue;}
    if(char===';'){statements.push(source.slice(start,i+1));start=i+1;}
  }
  if(source.slice(start).trim())statements.push(source.slice(start));
  if(quote||blockComment)throw new Error('SQLバックアップが途中で切れています');
  return statements;
}
function statementType(statement){
  let clean=statement.trim(),previous;
  do{previous=clean;clean=clean.replace(/^(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)\s*/,'');}while(previous!==clean);
  return clean;
}
export function orderDump(source){
  const tables=[],data=[],indexes=[];
  for(const statement of splitStatements(source)){
    const clean=statementType(statement);
    if(!clean||/^PRAGMA\b/i.test(clean))continue;
    if(/^CREATE\s+(?:TEMP\s+)?TRIGGER\b/i.test(clean))throw new Error('トリガーを含むバックアップの自動復元は未対応です');
    if(/^CREATE\s+TABLE\b/i.test(clean))tables.push(statement);
    else if(/^CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(clean))indexes.push(statement);
    else data.push(statement);
  }
  // D1 export interleaves CREATE/INSERT per table. With the deferred circular
  // head references, every referenced table must exist before the first INSERT.
  return ['PRAGMA defer_foreign_keys=ON;',...tables,...data,...indexes].join('\n');
}
