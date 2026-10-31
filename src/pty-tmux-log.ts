/** Executed inside tmux's pipe-pane process. No launch environment or prompt is persisted. */
export const ptyTmuxLogWriter = `
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const directory=process.argv[1];
const sockPath=process.argv[2];
const limit=1024*1024,keep=8;
let segment=0,size=0,carry=Buffer.alloc(0);
let fd=fs.openSync(path.join(directory,'0.chunk'),'a',0o600);
const clients=new Set();
let server=null;
if(sockPath){
  try{fs.unlinkSync(sockPath);}catch(e){}
  server=net.createServer(socket=>{
    try{socket.write(JSON.stringify({segment,size})+'\\n');}catch(e){}
    clients.add(socket);
    socket.on('close',()=>{clients.delete(socket);});
    socket.on('error',()=>{clients.delete(socket);try{socket.destroy();}catch(e){}});
  });
  server.listen(sockPath,()=>{try{fs.chmodSync(sockPath,0o600);}catch(e){}});
  process.on('exit',()=>{try{fs.unlinkSync(sockPath);}catch(e){}});
}
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
  for(const client of clients){
    try{client.write(data);}catch(e){}
  }
});
process.stdin.on('end',()=>{
  try{fs.closeSync(fd);}catch(e){}
  for(const client of clients){try{client.end();}catch(e){}}
  if(server){try{server.close(()=>{try{fs.unlinkSync(sockPath);}catch(e){}});}catch(e){}}
});
`;
