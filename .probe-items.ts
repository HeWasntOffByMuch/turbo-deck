import { readFileSync } from 'node:fs';
import { splitGlb, readNodeTree, readAccessor } from './src/units/glb-read.js';

for (const name of ['sword_jian', 'stick_knot']) {
  const glb = splitGlb(new Uint8Array(readFileSync(`assets/items/${name}/${name}.glb`)));
  const json = glb.json as any;
  const nodes = readNodeTree(glb);
  console.log(`\n=== ${name} ===`);
  console.log('nodes:', nodes.length, 'meshes:', json.meshes.length, 'materials:', json.materials?.length ?? 0);
  console.log('skins:', json.skins?.length ?? 0, 'animations:', json.animations?.length ?? 0);
  let tris = 0;
  const lo = [Infinity,Infinity,Infinity], hi = [-Infinity,-Infinity,-Infinity];
  for (const mesh of json.meshes) {
    for (const p of mesh.primitives) {
      tris += json.accessors[p.indices].count / 3;
      const a = json.accessors[p.attributes.POSITION];
      for (let i=0;i<3;i++){ lo[i]=Math.min(lo[i],a.min[i]); hi[i]=Math.max(hi[i],a.max[i]); }
    }
  }
  console.log('triangles:', tris);
  console.log('bounds  lo:', lo.map(v=>v.toFixed(4)).join(', '));
  console.log('        hi:', hi.map(v=>v.toFixed(4)).join(', '));
  console.log('extent   :', hi.map((v,i)=>(v-lo[i]).toFixed(4)).join(', '));
  console.log('parts:');
  for (const mesh of json.meshes) {
    const a = json.accessors[mesh.primitives[0].attributes.POSITION];
    console.log(`   ${mesh.name.padEnd(16)} z ${a.min[2].toFixed(3).padStart(7)} .. ${a.max[2].toFixed(3).padStart(6)}   x ±${Math.max(Math.abs(a.min[0]),Math.abs(a.max[0])).toFixed(3)}  y ±${Math.max(Math.abs(a.min[1]),Math.abs(a.max[1])).toFixed(3)}  mat=${json.materials?.[mesh.primitives[0].material]?.name ?? '-'}`);
  }
  console.log('node transforms:', nodes.filter(n=>n.translation.some(v=>v!==0)||n.rotation.some((v,i)=>v!==(i===3?1:0))).map(n=>n.name).join(',') || '(all identity)');
}
