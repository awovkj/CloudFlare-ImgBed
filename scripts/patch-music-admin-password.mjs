#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const bundlePath = path.join(root, 'js', '128.a59bdcad.js');
const marker = 'data-music-password-patch';

function countOccurrences(text, needle) {
  if (!needle) return 0;
  let count = 0;
  let position = 0;
  while ((position = text.indexOf(needle, position)) !== -1) {
    count += 1;
    position += needle.length;
  }
  return count;
}

function requireCount(text, needle, expected, label) {
  const actual = countOccurrences(text, needle);
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected} match(es), found ${actual}`);
  }
}

function replaceOnce(text, from, to, label) {
  requireCount(text, from, 1, label);
  return text.replace(from, to);
}

let bundle = fs.readFileSync(bundlePath, 'utf8');
const normalized = bundle.replace(/[ \t]+(?=\r?$)/gm, '').replace(/\r\n/g, '\n');
if (normalized !== bundle) {
  bundle = normalized;
  fs.writeFileSync(bundlePath, bundle, 'utf8');
}

if (bundle.includes(marker)) {
  requireCount(bundle, marker, 1, 'music password patch marker');
  requireCount(bundle, 'clearMusicPassword(){', 1, 'music password clear handler');
  requireCount(bundle, 'this.settings.musicPlayer.clearPassword=!0', 1, 'music password explicit clear flag');
  console.log('skip js/128.a59bdcad.js: music admin password patch already present');
  process.exit(0);
}

const originalMusicForm = '(0,s.Lk)("h3",null,[(0,s.eW)("音乐播放器")]),(0,s.bF)(d,{model:a.settings.musicPlayer,"label-width":"120px"},{default:(0,s.k6)(()=>[(0,s.bF)(c,{label:"启用"},{default:(0,s.k6)(()=>[(0,s.bF)(h,{modelValue:a.settings.musicPlayer.enabled,"onUpdate:modelValue":e[23]||(e[23]=t=>a.settings.musicPlayer.enabled=t),disabled:a.settings.musicPlayer.fixed},null,8,["modelValue","disabled"])]),_:1}),a.settings.musicPlayer.enabled?(0,s.bF)(c,{label:"音乐目录"},{default:(0,s.k6)(()=>[(0,s.bF)(u,{modelValue:a.settings.musicPlayer.musicDir,"onUpdate:modelValue":e[24]||(e[24]=t=>a.settings.musicPlayer.musicDir=t),placeholder:"music",disabled:a.settings.musicPlayer.fixed},null,8,["modelValue","disabled"])]),_:1}):(0,s.Q3)("",!0)]),_:1},8,["model"])';
const patchedMusicForm = '(0,s.Lk)("h3",null,[(0,s.eW)("音乐播放器")]),(0,s.bF)(d,{model:a.settings.musicPlayer,"label-width":"120px"},{default:(0,s.k6)(()=>[(0,s.bF)(c,{label:"启用"},{default:(0,s.k6)(()=>[(0,s.bF)(h,{modelValue:a.settings.musicPlayer.enabled,"onUpdate:modelValue":e[23]||(e[23]=t=>a.settings.musicPlayer.enabled=t),disabled:a.settings.musicPlayer.fixed},null,8,["modelValue","disabled"])]),_:1}),a.settings.musicPlayer.enabled?(0,s.bF)(c,{label:"音乐目录"},{default:(0,s.k6)(()=>[(0,s.bF)(u,{modelValue:a.settings.musicPlayer.musicDir,"onUpdate:modelValue":e[24]||(e[24]=t=>a.settings.musicPlayer.musicDir=t),placeholder:"music",disabled:a.settings.musicPlayer.fixed},null,8,["modelValue","disabled"])]),_:1}):(0,s.Q3)("",!0),(0,s.bF)(c,{label:"密码状态"},{default:(0,s.k6)(()=>[(0,s.Lk)("span",{"data-music-password-patch":"v1"},a.settings.musicPlayer.passwordConfigured?"已设置密码":"未设置密码",1)]),_:1}),(0,s.bF)(c,{label:"Music 密码"},{default:(0,s.k6)(()=>[(0,s.bF)(u,{modelValue:a.settings.musicPlayer.password,"onUpdate:modelValue":t=>a.settings.musicPlayer.password=t,type:"password",placeholder:"留空保持现有密码",autocomplete:"new-password",disabled:a.settings.musicPlayer.fixed},null,8,["modelValue","disabled"])]),_:1}),(0,s.bF)(c,{label:"清除密码"},{default:(0,s.k6)(()=>[(0,s.Lk)("button",{type:"button",disabled:!a.settings.musicPlayer.passwordConfigured,onClick:o.clearMusicPassword},"清除密码",8,["disabled"])]),_:1})]),_:1},8,["model"])';
bundle = replaceOnce(bundle, originalMusicForm, patchedMusicForm, 'music player password controls');

const originalMethods = 'methods:{saveSettings(){(0,Ut.A)("/api/manage/sysConfig/others",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(this.settings)}).then(()=>this.$message.success("设置已保存"))},async fetchAvailableChannels';
const patchedMethods = 'methods:{clearMusicPassword(){this.$confirm("确定要清除 Music 密码吗？清除后 Music 页面将不可访问。","清除 Music 密码",{confirmButtonText:"确定清除",cancelButtonText:"取消",type:"warning"}).then(()=>{this.settings.musicPlayer.clearPassword=!0,this.settings.musicPlayer.password="",this.settings.musicPlayer.passwordConfigured=!1}).catch(()=>{})},saveSettings(){const t=this.settings.musicPlayer?.password||"",e=!0===this.settings.musicPlayer?.clearPassword;(0,Ut.A)("/api/manage/sysConfig/others",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(this.settings)}).then(()=>{this.$message.success("设置已保存"),this.settings.musicPlayer&&(this.settings.musicPlayer.passwordConfigured=e?!1:this.settings.musicPlayer.passwordConfigured||!!t,this.settings.musicPlayer.password="",this.settings.musicPlayer.clearPassword=!1)})},async fetchAvailableChannels';
bundle = replaceOnce(bundle, originalMethods, patchedMethods, 'music password save and clear methods');

const originalLoad = '.then(t=>{this.settings=t}).finally(()=>{this.loading=!1}),this.fetchAvailableChannels()';
const patchedLoad = '.then(t=>{this.settings=t,this.settings.musicPlayer||(this.settings.musicPlayer={}),this.settings.musicPlayer.password="",this.settings.musicPlayer.clearPassword=!1}).finally(()=>{this.loading=!1}),this.fetchAvailableChannels()';
bundle = replaceOnce(bundle, originalLoad, patchedLoad, 'music password transient field initialization');

requireCount(bundle, marker, 1, 'music password patch marker after patch');
fs.writeFileSync(bundlePath, bundle, 'utf8');
console.log('patched js/128.a59bdcad.js with music admin password controls');
