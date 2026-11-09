// The Focus Room's sound: the soundscapes, the alarms and the soft breathing cues, all synthesised.
// Shared by focus.html and console.html (the Study's tablet console). `S` is the Focus Room's settings
// object (vol, duck, levels, alertFocus, alertBreak, alertVol, alertFade, alertRepeat); it is read live,
// so a page can change it in place and the engine follows.

export function createAudio(S) {
  const R = Math.random;
  // Nothing here is a loop, because the ear finds a loop within a minute and then can't stop hearing it.
  // Beds are long stereo noise read out in random stretches with soft crossfades. Drops, crackles and chirps
  // are rendered fresh a couple of seconds at a time, just ahead of the play head. Swells and gusts drift at
  // random, each sound's "weather" eases up and down over minutes, and now and then something rare happens.
  let ctx=null, master=null, duckG=null, fadeG=null, B=null, pump=null, NODES=null;
  const bufs={}, active={};
  const AHEAD=3, CHUNK=2, TAIL=2.5; // seconds: how far ahead to schedule, and the size of each fresh texture chunk
  function ac(){
    if(!ctx){ const C=window.AudioContext||window.webkitAudioContext; ctx=new C();
      master=ctx.createGain(); master.gain.value=S.vol*S.vol; duckG=ctx.createGain(); fadeG=ctx.createGain(); master.connect(duckG); duckG.connect(fadeG); fadeG.connect(ctx.destination); }
    if(ctx.state==="suspended") ctx.resume();
    return ctx;
  }
  // One timer feeds every playing sound. Background tabs slow timers to once a second, so it stays 3 s ahead.
  function pumpAll(){
    if(!ctx) return; const ids=Object.keys(active);
    if(!ids.length){ clearInterval(pump); pump=null; return; }
    const now=ctx.currentTime; ids.forEach(id=>active[id].jobs.forEach(j=>{ try{ j(now); }catch(e){ console.warn(e); } }));
  }
  function track(a,src,...rest){ a.nodes.add(src); src.onended=()=>{ a.nodes.delete(src); try{ src.disconnect(); rest.forEach(n=>n.disconnect()); }catch(e){} }; return src; }
  const n0=x=>Math.floor(x+R());          // a random whole number that averages x
  const pick1=xs=>xs[Math.floor(R()*xs.length)];
  const side=(w=.8)=>(R()*2-1)*w;         // a random spot between left and right

  // Noise beds: 31 s of independent left and right noise per colour, shared by every sound.
  function fillNoise(kind,g){
    if(kind==="white"){ for(let i=0;i<g.length;i++) g[i]=(R()*2-1)*.5; }
    else if(kind==="pink"){ let b0=0,b1=0,b2=0,b3=0,b4=0,b5=0,b6=0;
      for(let i=0;i<g.length;i++){const w=R()*2-1; b0=.99886*b0+w*.0555179; b1=.99332*b1+w*.0750759; b2=.969*b2+w*.153852; b3=.8665*b3+w*.3104856; b4=.55*b4+w*.5329522; b5=-.7616*b5-w*.016898; g[i]=(b0+b1+b2+b3+b4+b5+b6+w*.5362)*.11; b6=w*.115926;} }
    else { let last=0; for(let i=0;i<g.length;i++){const w=R()*2-1; last=(last+.02*w)/1.02; g[i]=last*3.5;} }
  }
  function noiseBuf(kind){
    const key="n_"+kind; if(bufs[key]) return bufs[key];
    const sr=ctx.sampleRate,b=ctx.createBuffer(2,Math.round(sr*31),sr);
    fillNoise(kind,b.getChannelData(0)); fillNoise(kind,b.getChannelData(1));
    return bufs[key]=b;
  }
  const XF=1.5, FADE_IN=new Float32Array(64).map((_,i)=>Math.sin(i/63*Math.PI/2)), FADE_OUT=FADE_IN.slice().reverse();
  // A bed plays 4–11 s stretches from random places in its buffer, crossfaded (equal power), so no order ever repeats.
  function bed(kind,gain,filters){
    const a=B, buf=noiseBuf(kind), head=ctx.createGain(); let n=head; const f=[];
    for(const [type,fr,q] of filters){const b=ctx.createBiquadFilter(); b.type=type; b.frequency.value=fr; if(q) b.Q.value=q; n.connect(b); n=b; f.push(b);}
    const g=ctx.createGain(); g.gain.value=gain; n.connect(g); g.connect(a.mix);
    let next=ctx.currentTime+.05, first=true;
    a.jobs.push(now=>{ while(next<now+AHEAD){
      const len=4+R()*7, off=R()*(buf.duration-len-XF-.1), s=ctx.createBufferSource(), e=ctx.createGain();
      s.buffer=buf; s.connect(e); e.connect(head);
      if(!first){ e.gain.value=0; e.gain.setValueCurveAtTime(FADE_IN,next,XF); }
      e.gain.setValueCurveAtTime(FADE_OUT,next+len,XF);
      s.start(next,off); s.stop(next+len+XF+.05); track(a,s,e);
      next+=len; first=false; } });
    return {g,f};
  }
  // An offset added to an AudioParam, for drifting and swelling it.
  function offs(param){ const cs=ctx.createConstantSource(); cs.offset.value=0; cs.connect(param); cs.start(); track(B,cs); return cs.offset; }
  // Wander a parameter by up to ±depth, heading somewhere new every tmin–tmax seconds. Never a steady cycle.
  function drift(param,depth,tmin,tmax){
    const o=offs(param); let next=0;
    B.jobs.push(now=>{ if(now<next) return; const d=tmin+R()*(tmax-tmin); o.setTargetAtTime(depth*(R()*2-1),now,d/3); next=now+d; });
  }

  // Texture helpers write into a stereo chunk c = {L, R, sr, D (seconds of events), k (weather), st (state kept between chunks)}.
  function pan(p){ const a=(p+1)*Math.PI/4; return [Math.SQRT2*Math.cos(a),Math.SQRT2*Math.sin(a)]; }
  function burst(c,t,dur,amp,freq,shape,p){ // band of noise around freq
    const [l,r]=pan(p||0),s=Math.floor(t*c.sr),len=Math.floor(dur*c.sr),w=2*Math.PI*freq/c.sr,N=c.L.length;
    for(let i=0;i<len&&s+i<N;i++){const q=i/len, env=shape==="swell"?Math.sin(Math.PI*q):Math.exp(-5*q), v=(R()*2-1)*Math.sin(w*i)*amp*env; c.L[s+i]+=v*l; c.R[s+i]+=v*r;}
  }
  function tone(c,t,dur,amp,f0,f1,att,p){ // sine glide with a soft tail
    const [l,r]=pan(p||0),s=Math.floor(t*c.sr),len=Math.floor(dur*c.sr),A=Math.max(1,(att||.005)*c.sr),N=c.L.length; let ph=0;
    for(let i=0;i<len&&s+i<N;i++){const q=i/len; ph+=2*Math.PI*f0*Math.pow(f1/f0,q)/c.sr; const v=Math.sin(ph)*amp*Math.min(1,i/A)*(1-q)*(1-q); c.L[s+i]+=v*l; c.R[s+i]+=v*r;}
  }
  const TEX={
    rain(c){ const D=c.D,k=c.k;
      for(let i=n0(30*D*k);i--;) burst(c,R()*D,.006+R()*.02,.04+Math.pow(R(),3)*.3,1500+R()*4500,0,side(.9));
      for(let i=n0(1.5*D*k);i--;) burst(c,R()*D,.03+R()*.03,.15+R()*.2,700+R()*900,0,side()); },
    cafe(c){ const D=c.D,k=c.k;
      for(let i=n0(8*D*k);i--;) burst(c,R()*D,.15+R()*.35,.05+R()*.06,250+R()*700,"swell",side());
      for(let i=n0(.45*D*k);i--;){const t=R()*D,f=2200+R()*2200,a=.05+R()*.06,p=side(); tone(c,t,.5,a,f,f,.001,p); tone(c,t,.3,a*.5,f*2.76,f*2.76,.001,p);}
      for(let i=n0(.2*D);i--;){const t=R()*D,p=side(); burst(c,t,.012,.25,2600,0,p); burst(c,t+.09,.01,.12,3000,0,p);} },
    fire(c){ let t=c.st.t||0;
      while(t<c.D){ let u=t; const n=1+Math.floor(R()*5), p=side(.6);
        for(let j=0;j<n;j++){ burst(c,u,.002+R()*.01,.12+Math.pow(R(),2)*.55,2500+R()*5000,0,p); u+=.01+R()*.08; }
        t+=-Math.log(1-R())*.45/c.k; }
      c.st.t=t-c.D;
      for(let i=n0(.25*c.D);i--;){const t=R()*c.D,p=side(.5); burst(c,t,.04,.5,900,0,p); burst(c,t+.03,.008,.5,4000,0,p);} },
    stream(c){ for(let i=n0(45*c.D*c.k);i--;){const f=300+R()*900; tone(c,R()*c.D,.01+R()*.035,.03+R()*.08,f,f*(1.4+R()*.8),.001,side(.7));} },
    birds(c){ let t=c.st.t==null?.4:c.st.t;
      while(t<c.D){ const ty=R(),amp=(.03+R()*.08)*(R()<.3?.45:1),p=side(.9); let u=t; // some birds are further off
        if(ty<.4){ const base=1800+R()*1600,n=2+Math.floor(R()*3); for(let j=0;j<n;j++){const f=base*(.85+R()*.4),d=.12+R()*.2; tone(c,u,d,amp,f,f*(.9+R()*.25),.02,p); u+=d+.05+R()*.1;} }
        else if(ty<.7){ const f=3800+R()*1800,n=6+Math.floor(R()*9); for(let j=0;j<n;j++){ tone(c,u,.045,amp*.8,f*(1-j*.01),f*(.92-j*.01),.003,p); u+=.06; } }
        else { const n=1+Math.floor(R()*3); for(let j=0;j<n;j++){ tone(c,u,.06,amp,2800+R()*600,4200+R()*800,.003,p); u+=.18+R()*.15; } }
        t=u+(.8+R()*3)/c.k; }
      c.st.t=t-c.D; },
    crickets(c){ const st=c.st;
      if(!st.cr) st.cr=[0,1,2,3].map(j=>({car:4300+R()*900,per:.45+R()*.35,amp:.03+R()*.04,t:j<3?R()*.6:8+R()*20,p:side()}));
      for(const q of st.cr){ const [l,r]=pan(q.p);
        while(q.t<c.D){
          if(R()<.012/c.k){ q.t+=4+R()*12; continue; } // a cricket falls quiet for a while, then carries on
          for(let p=0;p<3;p++){ const s=Math.floor((q.t+p*.035)*c.sr),len=Math.floor(.022*c.sr);
            for(let i=0;i<len&&s+i<c.L.length;i++){ const v=Math.sin(2*Math.PI*q.car*i/c.sr)*Math.sin(Math.PI*i/len)*q.amp; c.L[s+i]+=v*l; c.R[s+i]+=v*r; } }
          q.t+=q.per*(.9+R()*.2); }
        q.t-=c.D; } },
    clock(c){ // the tick stays steady; only the wood and the spring vary a hair
      const v=()=>1+(R()-.5)*.06;
      let m=v(); burst(c,.5,.012,.45*v(),3400*m,0,-.1); tone(c,.5,.04,.12*v(),2700*m,2600*m,.0005,-.1);
      m=v(); burst(c,1.5,.014,.4*v(),2300*m,0,-.1); tone(c,1.5,.05,.12*v(),1900*m,1850*m,.0005,-.1); }
  };
  // Render the next CHUNK seconds of a texture just before it's needed. Tails spill into the next chunk and simply add up.
  function tex(name,gain){
    const a=B, g=ctx.createGain(), st={}; g.gain.value=gain; g.connect(a.mix);
    let next=ctx.currentTime+.05;
    a.jobs.push(now=>{ while(next<now+AHEAD){
      const sr=ctx.sampleRate, b=ctx.createBuffer(2,Math.round((CHUNK+TAIL)*sr),sr);
      TEX[name]({L:b.getChannelData(0),R:b.getChannelData(1),sr,D:CHUNK,k:a.scene.v,st});
      const s=ctx.createBufferSource(); s.buffer=b; s.connect(g); s.start(next); track(a,s);
      next+=CHUNK; } });
  }
  // Rare moments, a few minutes apart: [seconds long, peak level, render].
  const RARE={
    thunder:[11,.28,c=>{ // distant thunder: a few rolls, nothing sharp
      const rolls=[[.2,1]]; for(let i=1+Math.floor(R()*3);i--;) rolls.push([.8+R()*3.5,.4+R()*.6]);
      const al=2*Math.PI*(90+R()*60)/c.sr;
      for(const ch of [c.L,c.R]){ let x=0,y=0;
        for(let i=0;i<ch.length;i++){ const t=i/c.sr; let e=0;
          for(const [t0,g] of rolls) if(t>t0){ const d=t-t0; e+=g*(1-Math.exp(-d/.35))*Math.exp(-d/1.8); }
          x+=(R()*2-1-x)*al; y+=(x-y)*al; ch[i]=y*e; } } }],
    log:[3,.4,c=>{ // a log settling into the grate
      const p=side(.6); tone(c,.05,.35,.6,95,55,.01,p); burst(c,.05,.08,.5,400,0,p);
      let t=.15; for(let i=12+Math.floor(R()*18);i--&&t<2.5;){ burst(c,t,.002+R()*.01,.1+R()*.5,2500+R()*5000,0,p+side(.2)); t+=.02+Math.pow(R(),2)*.25; } }],
    cafe:[3.5,.15,c=>{ const v=R(),p=side();
      if(v<.4){ burst(c,.05,.06,.5,180,0,p); burst(c,.06,.01,.3,1500,0,p); // the door, and its little bell
        for(let i=0;i<4;i++){ const f=2600*(i%2?1.19:1),t=.25+i*.11+R()*.03; tone(c,t,1.2,.12,f,f,.001,p); tone(c,t,.8,.05,f*2.7,f*2.7,.001,p); } }
      else if(v<.75){ let t=.05; for(let i=6+Math.floor(R()*8);i--;){ const f=2500+R()*3000; tone(c,t,.25,.05+R()*.08,f,f,.001,p); burst(c,t,.01,.2,f,0,p); t+=.02+R()*.09; } } // cutlery into a tray
      else { const f=250+R()*200; for(let i=0;i<25;i++) burst(c,.05+i*.022,.03,.12+.1*Math.sin(Math.PI*i/25),f*(1+i*.01),"swell",p); } }], // a chair scraping back
    garden:[4.5,.06,c=>{ const p=side();
      if(R()<.5){ const f=450+R()*80; [[0,.35,.6],[.45,.55,1],[1.1,.3,.6],[1.55,.3,.55],[1.95,.3,.5]].forEach(([t,d,a])=>tone(c,.1+t,d,a,f*1.04,f*.97,.06,p)); } // a wood pigeon
      else { const f=700+R()*400; for(let i=0;i<18;i++) burst(c,.1+i*.055,.02,1-i/22,f,0,p); } }], // a woodpecker, some way off
    owl:[3.5,.08,c=>{ const p=side(),f=520+R()*80; tone(c,.1,.6,.5,f,f*.93,.08,p); tone(c,1.3,.25,.35,f*.95,f*.9,.04,p); tone(c,1.65,1.4,.5,f,f*.9,.12,p); }],
    plop:[1.5,.15,c=>{ const p=side(.7); tone(c,.05,.12,.6,280+R()*80,900+R()*300,.002,p); for(let i=0;i<5;i++) burst(c,.1+R()*.25,.01+R()*.02,.1+R()*.15,1500+R()*2000,0,p); }],
    gull:[4,.15,c=>{ const p=side(); let t=.1;
      for(let i=2+Math.floor(R()*4);i--;){ const d=.25+R()*.2,f=1300+R()*300; tone(c,t,d,.5,f,f*.65,.03,p); tone(c,t,d,.25,f*2,f*1.3,.03,p); tone(c,t,d,.1,f*3,f*1.95,.03,p); t+=d+.08+R()*.15; } }],
    chime:[5,.18,c=>{ const sc=[1,1.125,1.25,1.5,1.667,2],b=900+R()*300,p=side(.6); let t=.05; // a wind chime next door
      for(let i=3+Math.floor(R()*5);i--&&t<2.2;){ const f=b*pick1(sc); tone(c,t,2.6,.25+R()*.2,f,f,.001,p); tone(c,t,1.2,.08,f*2.76,f*2.76,.001,p); t+=.08+R()*.5; } }]
  };
  function rare(name,tmin,tmax){
    const a=B; let next=ctx.currentTime+tmin*(.3+R()*.7);
    a.jobs.push(now=>{ if(next>now+AHEAD) return;
      const [dur,peak,fill]=RARE[name], sr=ctx.sampleRate, b=ctx.createBuffer(2,Math.round(dur*sr),sr), L=b.getChannelData(0), Rc=b.getChannelData(1);
      fill({L,R:Rc,sr}); let m=1e-9; for(let i=0;i<L.length;i++) m=Math.max(m,Math.abs(L[i]),Math.abs(Rc[i]));
      const F=Math.round(.3*sr); for(let i=0;i<L.length;i++){ const g=peak/m*Math.min(1,(L.length-i)/F); L[i]*=g; Rc[i]*=g; }
      const s=ctx.createBufferSource(); s.buffer=b; s.connect(a.mix); s.start(Math.max(next,now+.05)); track(a,s);
      next+=tmin+R()*(tmax-tmin); });
  }
  // Slow weather: each sound's intensity heads somewhere new every 40–150 s. It sets the density of events,
  // and moves the volume by `vol` of the change.
  function sceneJob(a,[lo,hi,vol]){ const s=a.scene;
    return now=>{ if(now>=s.t1){ s.from=s.v; s.to=lo+R()*(hi-lo); s.t0=now; s.t1=now+40+R()*110; }
      const p=Math.min(1,(now-s.t0)/(s.t1-s.t0)), e=p*p*(3-2*p); s.v=s.from+(s.to-s.from)*e;
      a.mix.gain.setTargetAtTime(1+vol*(s.v-1),now,1.5); };
  }
  function waves(){ // each wave rises, breaks and drags back over the shingle; sets come and go
    const a=B, w=bed("pink",.08,[["lowpass",350]]), h=bed("pink",0,[["highpass",2500],["lowpass",7000]]);
    const A=offs(w.g.gain), Fq=offs(w.f[0].frequency), H=offs(h.g.gain); let t=ctx.currentTime+.3;
    a.jobs.push(now=>{ while(t<now+AHEAD+4){ const k=a.scene.v, rise=2+R()*2.5, fall=4+R()*4, pk=(.22+R()*.32)*k;
      A.setTargetAtTime(pk,t,rise/3); Fq.setTargetAtTime((400+R()*700)*k,t,rise/3); H.setTargetAtTime(pk*.22,t+rise*.8,.6);
      A.setTargetAtTime(0,t+rise,fall/3); Fq.setTargetAtTime(0,t+rise,fall/2); H.setTargetAtTime(0,t+rise+.8,fall/2.5);
      t+=rise+fall*(.55+R()*.5)+(R()<.15?3+R()*5:R()*1.5); } });
  }

  const SOUNDS=[
    {id:"rain",name:"Rain",note:"Steady, on the window",trim:0.9,scene:[.55,1.3,.5],build(){ bed("pink",.4,[["highpass",450],["lowpass",6000]]); bed("brown",.3,[["lowpass",220]]); tex("rain",.7); rare("thunder",240,540); }},
    {id:"cafe",name:"Café",note:"Murmur and the odd cup",trim:1.2,scene:[.6,1.3,.3],build(){ const m=bed("pink",.35,[["bandpass",550,.9]]); drift(m.g.gain,.1,3,10); bed("brown",.2,[["lowpass",300]]); tex("cafe",.9); rare("cafe",90,240); }},
    {id:"fire",name:"Fireside",note:"Crackle and low roar",trim:0.65,scene:[.7,1.25,.3],build(){ const r=bed("brown",.5,[["lowpass",450]]); drift(r.g.gain,.15,1,4); drift(r.g.gain,.1,6,15); bed("pink",.04,[["bandpass",1500,.7]]); tex("fire",.8); rare("log",100,260); }},
    {id:"brown",name:"Brown noise",note:"Deep, even hush",trim:0.45,build(){ bed("brown",.75,[["lowpass",1000]]); }},
    {id:"white",name:"White noise",note:"Bright, even hiss",trim:0.3,build(){ bed("white",.5,[["lowpass",9000]]); }},
    {id:"waves",name:"Waves",note:"Slow surf on shingle",trim:0.85,scene:[.6,1.35,.2],build(){ waves(); bed("brown",.25,[["lowpass",180]]); rare("gull",120,300); }},
    {id:"wind",name:"Wind",note:"Gusts round the house",trim:0.9,scene:[.6,1.4,.4],build(){ const w=bed("pink",.9,[["bandpass",450,1.8]]); drift(w.f[0].frequency,250,4,12); drift(w.f[0].frequency,90,1.5,4); drift(w.g.gain,.35,5,15); drift(w.g.gain,.15,1.5,5); bed("brown",.25,[["lowpass",160]]); rare("chime",150,360); }},
    {id:"stream",name:"Stream",note:"Water over stones",trim:1.8,scene:[.8,1.15,.2],build(){ bed("white",.06,[["bandpass",2200,.6]]); bed("pink",.25,[["highpass",250],["lowpass",2500]]); tex("stream",.8); rare("plop",90,240); }},
    {id:"birds",name:"Birdsong",note:"A garden in spring",trim:3,scene:[.25,1.4,.15],build(){ bed("pink",.06,[["highpass",300],["lowpass",1500]]); tex("birds",.8); rare("garden",80,200); }},
    {id:"crickets",name:"Crickets",note:"A warm night outside",trim:2,scene:[.5,1.3,.2],build(){ bed("pink",.04,[["lowpass",600]]); tex("crickets",.72); rare("owl",180,420); }},
    {id:"clock",name:"Study clock",note:"Tick, tock, once a second",trim:1.3,build(){ tex("clock",.6); }}
  ];
  const MIXES=[
    {name:"Rainy study",set:{rain:.7,fire:.5}},
    {name:"Garden morning",set:{birds:.6,stream:.45,wind:.25}},
    {name:"Corner café",set:{cafe:.7,rain:.3}},
    {name:"Night watch",set:{crickets:.5,fire:.4,clock:.25}}
  ];
  const lvl=id=>S.levels[id]==null?.6:S.levels[id];
  const gainFor=id=>{const s=SOUNDS.find(x=>x.id===id); const l=lvl(id); return l*l*1.6*s.trim;};
  function startSound(id){
    ac(); if(active[id]) return;
    const snd=SOUNDS.find(x=>x.id===id), out=ctx.createGain(), mix=ctx.createGain(); out.gain.value=0; mix.connect(out); out.connect(master);
    const a={out,mix,jobs:[],nodes:new Set(),scene:{v:1,from:1,to:1,t0:0,t1:0}};
    if(snd.scene) a.jobs.push(sceneJob(a,snd.scene));
    B=a; snd.build(); B=null;
    out.gain.setTargetAtTime(gainFor(id),ctx.currentTime,.4);
    active[id]=a; pumpAll(); if(!pump) pump=setInterval(pumpAll,250);
  }
  function stopSound(id){
    const a=active[id]; if(!a) return; delete active[id];
    a.out.gain.setTargetAtTime(0,ctx.currentTime,.25);
    setTimeout(()=>{a.nodes.forEach(n=>{try{n.stop()}catch(e){}}); a.out.disconnect();},1600);
  }
  function setDuck(on){ if(!ctx) return; duckG.gain.setTargetAtTime(on&&S.duck?.35:1,ctx.currentTime,.8); }

  // Alarm sounds: all synthesised, scheduled on the audio clock so they ring on time even in a background tab.
  function note(o,f,t,a,att,dec,type){ const x=ctx.createOscillator(),g=ctx.createGain(); x.type=type||"sine"; x.frequency.setValueAtTime(f,t);
    g.gain.setValueAtTime(0,t); g.gain.linearRampToValueAtTime(a,t+att); g.gain.exponentialRampToValueAtTime(.0001,t+att+dec);
    x.connect(g); g.connect(o); x.start(t); x.stop(t+att+dec+.05); NODES&&NODES.push(x); return x; }
  function strike(o,t,f,amp){ [[1,1,3.6],[2.76,.35,2.2],[5.4,.15,1.3],[.5,.3,4.2]].forEach(([r,a,d])=>note(o,f*r,t,a*amp,.008,d)); }
  const ALERTS={
    bell:{name:"Temple bell",dur:5,play(t,o){ strike(o,t,528,.75); strike(o,t+1.3,470,.75); }},
    bowl:{name:"Singing bowl",dur:7,play(t,o){ note(o,220,t,.6,.08,7); note(o,221.6,t,.45,.08,7); note(o,596,t,.22,.06,5); note(o,1122,t,.09,.04,3); note(o,880,t,.08,.002,.25); }},
    chimes:{name:"Wind chimes",dur:3.6,play(t,o){ const f=[1047,1175,1319,1568,1760,2093]; [[3,0],[5,.18],[2,.42],[4,.55],[1,.8],[3,1.1],[0,1.35]].forEach(([k,d])=>{ note(o,f[k],t+d,.55,.003,2.4); note(o,f[k]*2.76,t+d,.12,.003,1.2); }); }},
    marimba:{name:"Marimba",dur:1.4,play(t,o){ [523.25,659.25,783.99].forEach((f,k)=>{ const u=t+k*.16; note(o,f,u,.8,.003,.7); note(o,f*4,u,.25,.002,.12); note(o,f*10,u,.05,.001,.04); }); }},
    piano:{name:"Piano phrase",dur:3,play(t,o){ [523.25,659.25,783.99,1046.5].forEach((f,k)=>{ const u=t+k*.2, dec=k===3?2.6:1.4; for(let n=1;n<=6;n++) note(o,f*n*(1+.0004*n*n),u,.6/Math.pow(n,1.3),.004,dec/(1+n*.3)); }); }},
    beep:{name:"Soft beep",dur:.6,play(t,o){ [0,.24].forEach(d=>{ const x=ctx.createOscillator(),g=ctx.createGain(); x.type="triangle"; x.frequency.value=880; const u=t+d;
        g.gain.setValueAtTime(0,u); g.gain.linearRampToValueAtTime(1,u+.01); g.gain.setValueAtTime(1,u+.12); g.gain.linearRampToValueAtTime(0,u+.15);
        x.connect(g); g.connect(o); x.start(u); x.stop(u+.2); NODES&&NODES.push(x); }); }},
    kettle:{name:"Kettle whistle",dur:3,play(t,o){
        const n=ctx.createBufferSource(); n.buffer=noiseBuf("white"); n.loop=true; const bp=ctx.createBiquadFilter(); bp.type="bandpass"; bp.Q.value=25;
        bp.frequency.setValueAtTime(1900,t); bp.frequency.linearRampToValueAtTime(2700,t+2.2);
        const ng=ctx.createGain(); ng.gain.setValueAtTime(0,t); ng.gain.linearRampToValueAtTime(4,t+2); ng.gain.setValueAtTime(4,t+2.5); ng.gain.linearRampToValueAtTime(0,t+2.8);
        n.connect(bp); bp.connect(ng); ng.connect(o); n.start(t); n.stop(t+2.9);
        const w=ctx.createOscillator(), wg=ctx.createGain(); w.frequency.setValueAtTime(1900,t); w.frequency.linearRampToValueAtTime(2700,t+2.2);
        const v=ctx.createOscillator(), vg=ctx.createGain(); v.frequency.value=6; vg.gain.value=25; v.connect(vg); vg.connect(w.frequency);
        wg.gain.setValueAtTime(0,t); wg.gain.linearRampToValueAtTime(.4,t+2); wg.gain.setValueAtTime(.4,t+2.5); wg.gain.linearRampToValueAtTime(0,t+2.8);
        w.connect(wg); wg.connect(o); w.start(t); v.start(t); w.stop(t+2.9); v.stop(t+2.9);
        if(NODES) NODES.push(n,w,v); }}
  };
  const alertGain=()=>.45*S.alertVol*S.alertVol;
  function playAt(id,t){ const o=ctx.createGain(); o.gain.value=alertGain(); o.connect(ctx.destination); NODES=[]; ALERTS[id].play(t,o); const nodes=NODES; NODES=null; return {o,nodes}; }
  // kind: focus (end of a focus block), break (end of a break or settling in), final (end of the session)
  function ring(at,kind){
    ac(); const now=ctx.currentTime; at=Math.max(now+.02,at);
    const id=kind==="focus"?S.alertFocus:S.alertBreak, A=ALERTS[id], times=[at];
    if(kind==="final") times.push(at+A.dur+.3);
    const lastT=times[times.length-1]; if(S.alertRepeat) for(let k=1;k<=20;k++) times.push(lastT+30*k);
    const plays=times.map(t=>playAt(id,t));
    // Soundscape fade over the last 30 seconds, then back up once the alarm has sounded.
    const g=fadeG.gain; g.cancelScheduledValues(now); g.setValueAtTime(g.value,now);
    if(S.alertFade){ const fs=Math.max(now+3,at-30); g.linearRampToValueAtTime(1,now+3);
      if(fs<at){ g.setValueAtTime(1,fs); g.linearRampToValueAtTime(.15,at); g.setTargetAtTime(1,times[kind==="final"?1:0]+A.dur*.6,1.5); } }
    else g.setTargetAtTime(1,now,.3);
    return {at,end:times[times.length-1]+A.dur,repeating:S.alertRepeat,
      cancel(restoreFade){ plays.forEach(p=>{ p.nodes.forEach(x=>{try{x.stop()}catch(e){}}); try{p.o.disconnect()}catch(e){} });
        if(restoreFade){ const n=ctx.currentTime; fadeG.gain.cancelScheduledValues(n); fadeG.gain.setValueAtTime(fadeG.gain.value,n); fadeG.gain.setTargetAtTime(1,n,.3); } }};
  }
  let previewH=null;
  function preview(id){ ac(); if(previewH) previewH.nodes.forEach(x=>{try{x.stop()}catch(e){}}); previewH=playAt(id,ctx.currentTime+.03); }
  function chimeOnce(id){ ac(); playAt(id,ctx.currentTime+.03); }
  function softTone(f){ if(!ctx||!S.cues) return; const t=ctx.currentTime,o=ctx.createOscillator(),g=ctx.createGain(); o.type="sine"; o.frequency.value=f;
    g.gain.setValueAtTime(0,t); g.gain.linearRampToValueAtTime(.06,t+.08); g.gain.exponentialRampToValueAtTime(.0001,t+1.1); o.connect(g); g.connect(ctx.destination); o.start(t); o.stop(t+1.2); }

  return {
    get ctx() { return ctx; }, get master() { return master; },
    ac, active, SOUNDS, MIXES, ALERTS, lvl, gainFor, startSound, stopSound, setDuck, ring, preview, chimeOnce, softTone,
  };
}

// Ideas for a break, used by the Focus Room's break card and the console's Stretch pick.
export const IDEAS = [
  {h:"A turn round the garden",p:"Ten minutes outside does you good. The fresh air is free.",min:8},
  {h:"Neck and shoulders",p:"Roll your shoulders back ten times, then ear to shoulder, twenty seconds a side."},
  {h:"Hip flexors",p:"Kneeling lunge, thirty seconds a side. The desk chair has not been kind to you."},
  {h:"Doorway chest stretch",p:"Forearms on the frame, step through and lean in for thirty seconds. Twice."},
  {h:"Wrists and forearms",p:"Prayer stretch, then reverse prayer, twenty seconds each. Bootcamp hands will thank you."},
  {h:"Rest your eyes",p:"Look at something at least twenty feet away for twenty seconds. Three times."},
  {h:"Put the kettle on",p:"Make a cup of tea and drink it away from the screen. Standing at a window counts."},
  {h:"Water and a wander",p:"Refill your glass and walk the length of the house and back."},
  {h:"Shake it out",p:"Stand, shake out your arms and legs for thirty seconds, then ten slow squats."}
];
