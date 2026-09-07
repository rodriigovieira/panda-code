import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { confinedPath, readBoundedFile, writeConfinedText } from "./confinedFiles";
it("refuses file and ancestor symlink escapes for reads and writes", () => {
 const dir=mkdtempSync("/tmp/panda-confined-");
 try {
  const root=join(dir,"workspace"); mkdirSync(root);
  const outside=join(dir,"outside.txt"); writeFileSync(outside,"private-canary");
  symlinkSync(outside,join(root,"linked.txt")); symlinkSync(dir,join(root,"parent"));
  for(const path of ["../outside.txt","linked.txt","parent/outside.txt"]) {
   expect(()=>readBoundedFile(join(root,path),100,root)).toThrow();
   expect(()=>writeConfinedText(root,path,"overwrite")).toThrow();
  }
  expect(readFileSync(outside,"utf8")).toBe("private-canary");
  expect(()=>confinedPath(root,"parent")).toThrow();
 } finally {rmSync(dir,{recursive:true,force:true});}
});
it("bounds reads, rejects binary/large writes, and permits in-root documents",()=>{
 const root=mkdtempSync("/tmp/panda-confined-");
 try {
  const path=join(root,"doc.txt"); writeFileSync(path,"hello world");
  expect(readBoundedFile(path,5,root)).toMatchObject({size:11,truncated:true});
  expect(readBoundedFile(path,5,root).bytes.toString()).toBe("hello");
  expect(()=>writeConfinedText(root,path,"x",5)).toThrow();
  expect(writeConfinedText(root,path,"new")).toBe(3);
  expect(readFileSync(path,"utf8")).toBe("new");
  writeFileSync(path,Buffer.from([0,1,2])); expect(()=>writeConfinedText(root,path,"x")).toThrow();
  expect(()=>readBoundedFile(root,100,root)).toThrow();
 } finally {rmSync(root,{recursive:true,force:true});}
});
