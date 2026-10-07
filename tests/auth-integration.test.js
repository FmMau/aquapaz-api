const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');
test('authentication, recovery, social handoff and revocation work against isolated PostgreSQL tables', {skip:process.env.RUN_DB_TESTS!=='1'},async()=>{
 require('dotenv').config({quiet:true});const {Client}=require('pg');const express=require('express');
 const client=new Client({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:10000});
 const oldSecret=process.env.JWT_SECRET;process.env.JWT_SECRET='isolated-auth-integration-test-secret';
 const deliveries=[];const mailer={ready:()=>true,sendCode:async(address,code)=>deliveries.push({address,code})};
 let server,savepoint=0;
 const pool={query:(...args)=>client.query(...args),connect:async()=>{const name=`auth_test_${++savepoint}`;return {release(){},query:async(sql,args)=>{
  if(sql==='BEGIN')return client.query(`SAVEPOINT ${name}`);if(sql==='COMMIT')return client.query(`RELEASE SAVEPOINT ${name}`);if(sql==='ROLLBACK')return client.query(`ROLLBACK TO SAVEPOINT ${name}`);return client.query(sql,args);
 }};}};
 let subject='google-user',providerEmail='user@example.test',exchanges=0;
 const provider={ready:()=>true,authorization:(name,state,nonce)=>`https://accounts.google.com/auth?state=${state}&nonce=${nonce}`,exchange:async()=>{exchanges++;return {subject,email:providerEmail,nombre:'Social name'};}};
 const file=path.join(__dirname,'../src/routes/auth-access.routes.js');const localRequire=require('node:module').createRequire(file);
 const context={module:{exports:{}},setTimeout,require:name=>name==='../database/db'?pool:name==='../services/auth-mail'?{createMailer:()=>mailer}:name==='../services/social-provider'?{createSocialProvider:()=>provider}:localRequire(name)};
 vm.runInNewContext(fs.readFileSync(file,'utf8'),context);
 const authFile=path.join(__dirname,'../src/middlewares/auth.middleware.js');const authContext={module:{exports:{}},console,process,require:name=>name==='../database/db'?pool:require(name)};
 vm.runInNewContext(fs.readFileSync(authFile,'utf8'),authContext);
 try{
  await client.connect();await client.query('BEGIN');
  // Temporary tables and their sequences shadow all real auth tables. Roll back every change.
  await client.query('CREATE TEMP TABLE usuarios(id SERIAL PRIMARY KEY,nombre varchar(100),email varchar(120) UNIQUE,telefono varchar(20),colonia varchar(100),password varchar(255),push_token text)');
  const migration=fs.readFileSync(path.join(__dirname,'../migrations/006_auth.sql'),'utf8').replace(/CREATE TABLE IF NOT EXISTS/g,'CREATE TEMP TABLE');await client.query(migration);
  const app=express();app.use(express.json());app.use('/api/auth',context.module.exports);app.get('/protected',authContext.module.exports,(req,res)=>res.json({id:req.user.id}));
  server=await new Promise(resolve=>{const listener=app.listen(0,'127.0.0.1',()=>resolve(listener));});const base=`http://127.0.0.1:${server.address().port}`;
  const post=async(url,body)=>{const response=await fetch(base+'/api/auth'+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
  const data={nombre:' Usuario ',email:' USER@Example.test ',telefono:'6121234567',colonia:'Centro',password:'password-original'};
  assert.equal((await post('/register',{...data,colonia:'Inventada'})).status,400);
  const registered=await post('/register',data);assert.equal(registered.status,200);assert.equal(registered.body.user.email,'user@example.test');assert.equal(registered.body.user.password,undefined);
  assert.equal((await post('/register',{...data,email:'user@example.test'})).status,409);
  const login=await post('/login',{email:' User@example.test ',password:data.password});assert.equal(login.status,200);
  const missing=await post('/login',{email:'unknown@example.test',password:'incorrect'}),wrong=await post('/login',{email:data.email,password:'incorrect'});assert.equal(missing.status,401);assert.equal(missing.body.error,wrong.body.error);
  const absent=await post('/password/forgot',{email:'unknown@example.test'});assert.equal(deliveries.length,0);
  const forgot=await post('/password/forgot',{email:data.email});assert.equal(forgot.body.message,absent.body.message);assert.equal(deliveries.length,1);
  const code=deliveries[0].code;assert.match(code,/^\d{8}$/);assert.notEqual((await client.query('SELECT code_hash FROM auth_resets')).rows[0].code_hash,code);
  const wrongCode=code==='00000000'?'11111111':'00000000';
  for(let i=0;i<4;i++)assert.equal((await post('/password/reset',{email:data.email,code:wrongCode,password:'password-updated'})).status,400);
  assert.equal((await post('/password/reset',{email:data.email,code,password:'password-updated'})).status,200);
  assert.equal((await post('/password/reset',{email:data.email,code,password:'password-updated'})).status,400);
  assert.equal((await fetch(base+'/protected',{headers:{Authorization:'Bearer '+login.body.token}})).status,401);
  assert.equal((await post('/login',{email:data.email,password:data.password})).status,401);
  assert.equal((await post('/login',{email:data.email,password:'password-updated'})).status,200);
  await post('/password/forgot',{email:data.email});await client.query("UPDATE auth_resets SET expires_at=NOW()-INTERVAL '1 second'");
  assert.equal((await post('/password/reset',{email:data.email,code:deliveries[1].code,password:'another-password'})).status,400);
  // Fresh IP reset quota for the independent five-attempt case (only temporary counters).
  await client.query('DELETE FROM auth_limits');await post('/password/forgot',{email:data.email});
  const third=deliveries[2].code,incorrect=third==='00000000'?'11111111':'00000000';
  for(let i=0;i<5;i++)assert.equal((await post('/password/reset',{email:data.email,code:incorrect,password:'another-password'})).status,400);
  assert.equal((await post('/password/reset',{email:data.email,code:third,password:'another-password'})).status,400);
  const {challenge}=require('../src/services/auth-security');const verifier='a'.repeat(64);
  const handoff=async(name)=>{
   const start=await post('/social/start',{provider:name,code_challenge:challenge(verifier)});assert.equal(start.status,200);const state=new URL(start.body.url).searchParams.get('state');
   const response=await fetch(base+'/api/auth/social/callback/'+name+'?'+new URLSearchParams({state,code:'valid-provider-code'}),{redirect:'manual'});assert.equal(response.status,303);
   const code=new URL(response.headers.get('location')).searchParams.get('code');return {state,proof:{code,code_verifier:verifier}};
  };
  const linked=await handoff('google');assert.equal((await post('/social/inspect',{...linked.proof,code_verifier:'b'.repeat(64)})).status,401);
  assert.equal((await post('/social/inspect',linked.proof)).body.action,'link');
  assert.equal((await post('/social/finish',{...linked.proof,password:'wrong'})).status,401);
  const complete=await post('/social/finish',{...linked.proof,password:'password-updated'});assert.equal(complete.status,200);assert.equal(complete.body.user.id,registered.body.user.id);
  assert.equal((await post('/social/finish',linked.proof)).status,401);
  const replay=await fetch(base+'/api/auth/social/callback/google?'+new URLSearchParams({state:linked.state,code:'valid-provider-code'}),{redirect:'manual'});assert.equal(replay.status,400);assert.equal(exchanges,1);
  providerEmail='new-provider-email@example.test';const returning=await handoff('google');assert.equal((await post('/social/inspect',returning.proof)).body.action,'login');
  assert.equal((await post('/social/finish',returning.proof)).body.user.id,registered.body.user.id);
  subject='apple-user';providerEmail='apple@example.test';const newcomer=await handoff('apple');assert.equal((await post('/social/inspect',newcomer.proof)).body.action,'register');
  assert.equal((await post('/social/finish',newcomer.proof)).status,400);
  const social=await post('/social/finish',{...newcomer.proof,profile:{nombre:'Apple account',telefono:'6121234567',colonia:'Indeco',email:'forged@example.test'}});assert.equal(social.status,200);assert.equal(social.body.user.email,'apple@example.test');assert.equal(social.body.user.colonia,'Indeco');
  const {limit}=require('../src/services/auth-security');await limit(pool,'test','ip',1,15);await assert.rejects(limit(pool,'test','ip',1,15),error=>error.status===429);
 }finally{
  if(server)await new Promise(resolve=>server.close(resolve));await client.query('ROLLBACK').catch(()=>{});await client.end();if(oldSecret===undefined)delete process.env.JWT_SECRET;else process.env.JWT_SECRET=oldSecret;
 }
});
