const ytdl = require('ytdl-core');
const fs = require('fs');
(async()=>{
  try {
    const url='https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    const tmp='/tmp/test_audio.mp3';
    console.log('starting download');
    await new Promise((res,rej)=>{
      const stream=ytdl(url,{filter:'audioonly',quality:'highestaudio',highWaterMark:1<<25});
      stream.pipe(fs.createWriteStream(tmp));
      stream.on('error',rej);
      stream.on('end',res);
    });
    console.log('download finished', fs.statSync(tmp).size);
  } catch(e){
    console.error('error',e);
  }
})()
