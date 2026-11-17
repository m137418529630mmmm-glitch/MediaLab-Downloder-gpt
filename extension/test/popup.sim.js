const fs=require("fs");const t=fs.readFileSync(require("path").join(__dirname, "..", "popup.js"),"utf8");
const a=t.indexOf("const isAudioItem"); const b=t.indexOf("function showMedia");
eval(t.slice(a,b)+";globalThis.groupMedia=groupMedia;");
const tab={title:"Businessman, Suit, Office, Working by Azulroto - Stock Footage",url:"https://artlist.io/x"};
const base="https://cms-public-artifacts.artlist.io/content/artgrid/footage-hls/c43db1";
const items=[
 {label:"Video · MP4 · stream",sub:base+"/a.m3u8",url:base+"/master.m3u8",ext:"ts"},
 {label:"Other qualities of this stream…",resolve:base+"/master.m3u8",ext:"mp4"},
 {label:"1080p · MP4 · stream",url:base+"/1080/index.m3u8",ext:"ts"},
 {label:"720p · MP4 · stream",url:base+"/720/index.m3u8",ext:"ts"},
 {label:"Video · MP4 · stream",url:base+"/360/index.m3u8",ext:"ts"},
 {label:"MP3 · 2.1 MB",url:"https://cdn.site.com/sfx/Door%20Slam.mp3",ext:"mp3",audio:true},
];
const r=groupMedia(items,tab,"page");
console.log("video entries:",r.videoList.length, r.videoList.map(g=>g.name.slice(0,25)+" -> "+g.opts.map(o=>o.label).join(" | ")));
console.log("audio entries:",r.audioList.length, r.audioList.map(g=>g.name));
const yt=[{label:"1080p Full HD · MP4",yt:{quality:"1080p",ext:"mp4",key:"1080p|MP4",source:"https://www.youtube.com/watch?v=abc",title:"My Video"}},{label:"720p HD · MP4",yt:{quality:"720p",ext:"mp4",key:"720p|MP4",source:"https://www.youtube.com/watch?v=abc",title:"My Video"}},{label:"Audio · MP3 192k",yt:{quality:"mp3",ext:"mp3",key:"mp3",source:"https://www.youtube.com/watch?v=abc",title:"My Video"}}];
const r2=groupMedia(yt,tab,"page");
console.log("yt video:",r2.videoList.length,r2.videoList[0].name,r2.videoList[0].opts.length,"| audio:",r2.audioList.length);
const assert = require("assert");
assert.strictEqual(r.videoList.length, 1, "one entry for the one video");
assert.strictEqual(r.videoList[0].opts.length, 2, "its qualities inside it");
assert.strictEqual(r.audioList.length, 1, "the sound apart");
assert.strictEqual(r2.videoList[0].name, "My Video");
assert.strictEqual(r2.audioList.length, 1);
console.log("popup simulation: all checks passed");
