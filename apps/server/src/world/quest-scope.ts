/** Detect structured v3 provenance, including stored continuations; never inspect prose keywords. */
export function hasQuestHistory(source:string):boolean {
  let nodes=0;
  const walk=(value:unknown,depth:number):boolean=>{
    if(depth>64 || ++nodes>50_000)return true; // Fail closed for over-complex imported trees.
    if(!value || typeof value!=="object")return false;
    if(Array.isArray(value))return value.some(v=>walk(v,depth+1));
    const o=value as Record<string,unknown>;
    if(o.schemaVersion===3 && (Array.isArray(o.questStates)||Array.isArray(o.quests)))return true;
    for(const [key,v] of Object.entries(o)){
      if(key==='continuation' && Array.isArray(v)){
        for(const line of v)if(typeof line==='string'){let parsed:unknown;try{parsed=JSON.parse(line);}catch{continue;}if(walk(parsed,depth+1))return true;}
      }else if(walk(v,depth+1))return true;
    }
    return false;
  };
  for(const line of source.split('\n')){let parsed:unknown;try{parsed=JSON.parse(line);}catch{continue;}if(walk(parsed,0))return true;}
  return false;
}
