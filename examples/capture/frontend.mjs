import { createServer } from 'node:http';

const api = JSON.stringify(process.env.CAPTURE_API_URL || 'http://localhost:4301');
const body = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Notes</title>
<style>body{font:18px system-ui;max-width:700px;margin:2rem auto;padding:1rem}input,button{font:inherit;padding:.5rem;margin:.3rem}li{padding:.4rem}</style>
<main id="app"></main><script>
const api=${api};
const root=document.querySelector('#app');
async function call(path,body){
  const response=await fetch(api+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',Authorization:'Bearer '+(localStorage.getItem('token')||'')},body:body?JSON.stringify(body):undefined});
  if(!response.ok)throw Error('Request failed: '+response.status);
  return response.json();
}
async function render(){
  if(!localStorage.getItem('token')){
    root.innerHTML='<h1>Sign in</h1><form id="login"><input id="username" aria-label="Username" autocomplete="username"><input id="password" aria-label="Password" type="password"><button>Sign in</button></form>';
    document.querySelector('#login').onsubmit=async event=>{event.preventDefault();const result=await call('/login',{username:document.querySelector('#username').value,password:document.querySelector('#password').value});localStorage.setItem('token',result.token);await render();};return;
  }
  const result=await call('/notes');
  root.innerHTML='<button id="signout">Sign out</button><h1>Notes</h1><ul id="notes"></ul><form id="add"><input id="title" aria-label="Note title"><button id="save">Save note</button></form>';
  for(const text of result.notes){const li=document.createElement('li');li.className='note';li.textContent=text;document.querySelector('#notes').append(li);}
  document.querySelector('#signout').onclick=()=>{localStorage.removeItem('token');render();};
  document.querySelector('#add').onsubmit=async event=>{event.preventDefault();await call('/notes',{title:document.querySelector('#title').value});await render();};
}
render().catch(()=>{root.textContent='Could not load the application';});
</script></html>`;
createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end(body); })
  .listen(Number(process.env.FRONTEND_PORT || 4300), '127.0.0.1');
