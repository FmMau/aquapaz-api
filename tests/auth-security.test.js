const {test}=require('node:test');const assert=require('node:assert/strict');
const {profileError,validPassword,email,validEmail}=require('../src/services/auth-validation');
const {createPasswordAuth}=require('../src/services/password-auth');
const {createSocialProvider,verifyIdentity}=require('../src/services/social-provider');
test('server validates bounded profile, canonical colony and UTF-8 password bytes',()=>{
 const profile={nombre:'Usuario',telefono:'6121234567',colonia:'Centro'};assert.equal(profileError(profile),null);
 for(const invalid of [{nombre:' '},{nombre:'x'.repeat(101)},{nombre:'bad\nname'},{telefono:'123'},{colonia:'inventada'}])assert.ok(profileError({...profile,...invalid}));
 assert.equal(validPassword('á'.repeat(36)),true);assert.equal(validPassword('á'.repeat(37)),false);assert.equal(validPassword('😀'.repeat(19)),false);assert.equal(validPassword('        '),false);
 assert.equal(email(' USER@Example.test '),'user@example.test');
 for(const address of ['user@domain.test,other','name<user@domain.test>','user@domain..test','user@-domain.test'])assert.equal(validEmail(address),false);
});
test('unconfigured recovery and providers fail explicitly without sending mail or calling providers',async()=>{
 const auth=createPasswordAuth({pool:{query:()=>assert.fail('No SQL')},mailer:{ready:()=>false,sendCode:()=>assert.fail('No mail')}});
 await assert.rejects(auth.forgot({email:'user@example.test'}),error=>error.status===503);
 const provider=createSocialProvider({},()=>assert.fail('No external fetch'));
 assert.equal(provider.ready('google'),false);assert.equal(provider.ready('apple'),false);assert.throws(()=>provider.authorization('google','state','nonce','challenge'),error=>error.status===503);
});
test('social authorization uses fixed HTTPS callback, state, nonce and Google PKCE',()=>{
 const provider=createSocialProvider({AUTH_PUBLIC_URL:'https://api.example.test',GOOGLE_CLIENT_ID:'client',GOOGLE_CLIENT_SECRET:'secret'});
 const url=new URL(provider.authorization('google','state','nonce','proof'));
 assert.equal(url.origin,'https://accounts.google.com');assert.equal(url.searchParams.get('redirect_uri'),'https://api.example.test/api/auth/social/callback/google');assert.equal(url.searchParams.get('state'),'state');assert.equal(url.searchParams.get('nonce'),'nonce');assert.equal(url.searchParams.get('code_challenge_method'),'S256');
 assert.equal(createSocialProvider({AUTH_PUBLIC_URL:'http://api.example.test',GOOGLE_CLIENT_ID:'client',GOOGLE_CLIENT_SECRET:'secret'}).ready('google'),false);
});
test('signed provider tokens reject wrong signature, issuer, audience, nonce, expiry and unverified email',async()=>{
 const {generateKeyPair,exportJWK,createLocalJWKSet,SignJWT}=await import('jose');
 const keys=await generateKeyPair('RS256');const publicKey=await exportJWK(keys.publicKey);publicKey.kid='test';const jwks=createLocalJWKSet({keys:[publicKey]});
 const settings={issuer:'https://accounts.google.com',clientId:'test-audience'};
 const token=async(overrides={},key=keys.privateKey)=>new SignJWT({sub:'provider-subject',nonce:'test-nonce',email:'user@example.test',email_verified:true,...overrides}).setProtectedHeader({alg:'RS256',kid:'test'}).setIssuedAt().setIssuer(overrides.iss||settings.issuer).setAudience(overrides.aud||settings.clientId).setExpirationTime(overrides.exp||'5m').sign(key);
 const verify=encoded=>verifyIdentity({token:encoded,settings,nonce:'test-nonce',jwks});
 assert.equal((await verify(await token())).subject,'provider-subject');
 for(const claims of [{nonce:'other'},{iss:'https://evil.test'},{aud:'other'},{exp:1},{email_verified:false},{azp:'other-client'},{sub:''}])await assert.rejects(verify(await token(claims)));
 const other=await generateKeyPair('RS256');await assert.rejects(verify(await token({},other.privateKey)));
});
