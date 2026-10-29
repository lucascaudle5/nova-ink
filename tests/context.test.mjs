import assert from 'node:assert/strict'
import test from 'node:test'
import { intersectsViewport, makeCanvasContext } from '../src/context.ts'

test('selected shapes override visible viewport', () => {
  const shapes=[{id:'a',type:'draw',x:2.1,y:3.8,props:{color:'red'}},{id:'b',type:'text',x:5,y:6,props:{text:'hello'}}]
  const result=makeCanvasContext(shapes,['b'],'Give a hint',['a'])
  assert.equal(result.scopeShapes,1)
  assert.equal(result.scope,'selected shapes')
  assert.equal(result.shapes[0].id,'b')
})
test('only visible shapes enter screenshot context by default', () => {
  const shapes=[{id:'visible',type:'draw',x:0,y:0,props:{}},{id:'peripheral',type:'text',x:100,y:100,props:{text:'do not export'}}]
  const result=makeCanvasContext(shapes,[],'Am I correct?',['visible'])
  assert.equal(result.scope,'visible viewport')
  assert.equal(result.scopeShapes,1)
  assert.equal(result.peripheralShapes,1)
  assert.equal(result.shapes[0].id,'visible')
})
test('viewport intersection uses page-space bounds', () => {
  const v={x:0,y:0,w:100,h:100}
  assert.equal(intersectsViewport({x:80,y:80,w:30,h:30},v),true)
  assert.equal(intersectsViewport({x:101,y:101,w:20,h:20},v),false)
  assert.equal(intersectsViewport({x:-30,y:50,w:20,h:10},v),false)
})
test('context is bounded and not described as visual recognition', () => {
  const shapes=Array.from({length:50},(_,i)=>({id:String(i),type:'draw',x:i,y:i,props:{segments:[{},{}]}}))
  const result=makeCanvasContext(shapes,[],'X'.repeat(2000),shapes.map(x=>x.id))
  assert.equal(result.shownShapes,24)
  assert.equal(result.question.length,1200)
  assert.match(result.limitation,/Never claim/)
  assert.match(result.shapes[0].props.segments,/not included/)
})
