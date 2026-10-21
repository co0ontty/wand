/** Executed inside tmux's pipe-pane process. No launch environment or prompt is persisted. */
export const ptyTmuxLogWriter = `
const fs=require('node:fs'),path=require('node:path');
const directory=process.argv[1];
const limit=1024*1024,keep=8;
let segment=0,size=0,carry=Buffer.alloc(0);
let fd=fs.openSync(path.join(directory,'0.chunk'),'a',0o600);
process.stdin.on('data',data=>{
  const scan=Buffer.concat([carry,data]);
  const start=scan.lastIndexOf(Buffer.from('\\x1eWAND_CLI_EXIT:'));
  if(start>=0){const end=scan.indexOf(31,start);if(end>=0){
    const marker=scan.subarray(start,end+1);
    fs.writeFileSync(path.join(directory,'marker.tmp'),marker,{mode:0o600});
    fs.renameSync(path.join(directory,'marker.tmp'),path.join(directory,'marker'));
  }}
  carry=scan.subarray(Math.max(0,scan.length-512));
  for(let offset=0;offset<data.length;){
    if(size>=limit){fs.closeSync(fd);segment++;size=0;
      fd=fs.openSync(path.join(directory,segment+'.chunk'),'a',0o600);
      if(segment>=keep)fs.unlinkSync(path.join(directory,(segment-keep)+'.chunk'));
    }
    const length=Math.min(limit-size,data.length-offset);
    fs.writeSync(fd,data,offset,length);offset+=length;size+=length;
  }
});
process.stdin.on('end',()=>{fs.closeSync(fd);});
`;
