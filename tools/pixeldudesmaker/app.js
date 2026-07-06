// It's such a mess that i don't think it's worth reading
// You were warned!

const $ = document.querySelector.bind(document);
const $$ = document.querySelectorAll.bind(document);
const pad2 = (n) => ("000" + n).slice(-2);
const b2Hex = (r, g, b) => ( "#" +
  pad2(r.toString(16)) +
  pad2(g.toString(16)) +
  pad2(b.toString(16))
);
const hex2R = (hex) => parseInt(hex.slice(1, 3), 16);
const hex2G = (hex) => parseInt(hex.slice(3, 5), 16);
const hex2B = (hex) => parseInt(hex.slice(5, 7), 16);
const hex2Arr = (h) => [hex2R(h), hex2G(h), hex2B(h)];


const img2b64 = (img) => {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvas.height = img.naturalHeight;
  canvas.width = img.naturalWidth;
  ctx.drawImage(img, 0, 0);
  return canvas.toDataURL("image/png").replace("data:image/png;base64,", "");
}

const getData = async (filename) => {
  const resp = await fetch(filename);
  const buf = await resp.arrayBuffer();
  loadZip(buf);
}

const loadZip = (buf) => {
  const data = new Uint8Array(buf)

  JSZip.loadAsync(data).then((zip) => {
    zip.file("conf.json").async("string").then((str) => {
      const conf = JSON.parse(str);
      setupConf(conf, zip.files);
    });
  }).catch(function(err) {
      console.error("Failed to open", filename, " as ZIP file:", err);
  });
}

{
  let configFileInput = $("#importconfig");

  configFileInput.onchange = () => {
    const file = configFileInput.files[0];
    const fr = new FileReader();

    fr.addEventListener("load", () => {
      console.log(fr.result);
      loadZip(fr.result);
      configFileInput.value = "";
    }, false);

    fr.readAsArrayBuffer(file);
  }
}


// getData("./data/default.zip");
getData("./data/Archive.zip");

const State = {
  anim: "idle", // "no", "idle", "run"
  base: 0,
  head: 1,
  face: 0,
  getAnimX0: function(animName, frame) {
    if (animName == "idle") return 2 + frame;
    if (animName == "run") return 7 + frame;
    return 0;
  },
  modF: function(f) {
    if (this.anim == "idle") return (f % 4);
    if (this.anim == "run") return (f % 4);
    return 0;
  },
  readFromUi: function() {
    this.base = +Parts.els.bases.value;
    this.head = +Parts.els.heads.value;
    this.face = +Parts.els.faces.value;
  }
};

const Conf = {
  data: {},
  getW: function() { return this.data.w || 16; },
  getH: function() { return this.data.h || 16; },
  getOy: function(key, anim, frame)
  {
    const d = this.data;
    if (!d || !d.parts || !d.parts[key]) return 0;
    const p = d.parts[key];
    if (!p || !p[anim]) return 0;
    return p[anim][frame] || 0;
  },

  shadowSuit: function() { return this.data.suitShadowMod || 0.5; },
  shadowItem: function() { return this.data.itemShadowMod || 0.5; },
  shadowBody: function() { return this.data.bodyShadowMod || 0.5; },
  shadowHair: function() { return this.data.hairShadowMod || 0.5; },
};

let outlineColorComponent;

const setupConf = (conf, files) => {
  Conf.data = conf;

  sliderShadowModsAllSetup();

  const cc = ColorComponent(conf.outlineColor,
    (rgb) => (Conf.data.outlineColor = rgb));
  cc.el.style.display = "inlie-block";
  $("#color_outline").innerText = "";
  $("#color_outline").append(cc.el);
  outlineColorComponent = cc;

  Pal.all.eyes.setColors(conf.pals.eyes);
  Pal.all.body.setColors(conf.pals.body);
  Pal.all.item.setColors(conf.pals.item);
  Pal.all.suit.setColors(conf.pals.suit);
  Pal.all.hair.setColors(conf.pals.hair);

  // parts
  Parts.reset();
  console.assert(files["base.png"], "base.png expected");
  console.assert(files["heads.png"], "heads.png expected");
  console.assert(files["faces.png"], "faces.png expected");

  Parts.addBase(files["base.png"]);
  Parts.addHead(files["heads.png"]);
  Parts.addFace(files["faces.png"]);

  // const _png = (prefix, n) => (n.startsWith(prefix) && n.endsWith(".png"));
  // for (let name in files) {
  //   if (_png("head_", name)) Parts.addHead(files[name]);
  //   else if (_png("face_", name)) Parts.addFace(files[name]);
  //   else if (_png("base_", name))
  //   // else ignore!
  // }
}

const b64_to_img = (b64, onload) => {
  const img = new Image();
  img.src = "data:image/png;base64," + b64;
  img.onload = () => onload(img);
}

const setupPalette = (pal, pal64) => {
  b64_to_img(pal64, (img) => {
    const canvas = document.createElement("canvas");
    canvas.height = 1;
    canvas.width = Math.min(64, img.width);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const id = ctx.getImageData(0, 0, img.width, img.height).data;

    for (let i=0; i<img.width*4; i+=4) {
      pal.addColor(b2Hex(id[i+0], id[i+1], id[i+2]));
    }
    pal.render();
  });
}

const Pal = (key, sel) => {
  Pal.all = Pal.all || {};
  Pal.all[key] = {
    el: $(sel),
    active: "",
    isLocked: false,
    colors: [],
    resetColors: function() { this.colors = []; },
    addColor: function(c) { this.colors.push(c); },

    setColors: function(arr) {
      this.colors = arr;
      this.render();
      this.randomize();
    },

    mkBtn: function(itemsEl, hex) {
      const c = document.createElement("button");
      this.btns.push(c);
      c.className = "palItem";
      c.dataset.color = hex;
      c.style.background = hex;
      itemsEl.append(c);
      c.onclick = (e) => {
        this.active = c.dataset.color;
        this.activeBtn = c;
        this.refreshActive();

        this.colorComponent.set(c.dataset.color);
        this.activeR = hex2R(this.active);
        this.activeG = hex2G(this.active);
        this.activeB = hex2B(this.active);
      }

      return c;
    },
    render: function() {
      this.el.innerText = "";
      const locked = document.createElement("input");
      locked.type = "checkbox";
      locked.checked = !!this.isLocked;
      locked.onchange = () => (this.isLocked = locked.checked);

      const label = document.createElement("label");
      label.className = "lock";
      label.append(locked);
      label.append(document.createElement("span"));
      label.append(" " + key + ": ")

      const more = document.createElement("button");
      more.innerText = "m";
      more.style.margin = "0 10px";
      more.className = "btn sm";

      const itemsEl = document.createElement("div");
      this.itemsEl = itemsEl;
      itemsEl.className = "palItems";
      itemsEl.append(label);
      itemsEl.append(more);

      this.el.append(itemsEl);
      this.btns = [];

      this.colors.forEach((hex) => {
        this.mkBtn(itemsEl, hex);
      });

      this.colorComponent = ColorComponent(this.colors[0] || "#000000", (rgb, hex) => {
        const idx = this.btns.indexOf(this.activeBtn);
        this.colors[idx] = hex;
        this.activeBtn.style.background = hex;
        this.activeBtn.dataset.color = hex;
        this.active = hex;
        this.activeR = hex2R(this.active);
        this.activeG = hex2G(this.active);
        this.activeB = hex2B(this.active);
      });
      this.colorComponent.el.style.paddingLeft = "90px";
      //this.colorComponent.toggle();

      this.colorComponentWrap = document.createElement("div");
      this.colorComponentWrap.append(this.colorComponent.el);
      this.el.append(this.colorComponentWrap);

      more.onclick = () => {
        const n = this.colorComponentWrap.style.display !== "none";
        this.colorComponentWrap.style.display = n ? "none" : "inline-block";
      }
      more.onclick();

      this.colorComponentWrap.append(" :: ");
      const rem = document.createElement("button");
      rem.className = "btn sm";
      rem.innerText = "rem";
      rem.onclick = () => this.removeActive();
      this.colorComponentWrap.append(rem);

      this.colorComponentWrap.append(" ");
      const dup = document.createElement("button");
      dup.className = "btn sm";
      dup.innerText = "dup";
      dup.onclick = () => this.dupActive();
      this.colorComponentWrap.append(dup);
    },

    dupActive: function() {
      this.colors.push(this.active);
      const c = this.mkBtn(this.itemsEl, this.active);
      this.activeBtn = c;
      this.refreshActive();
    },

    removeActive: function() {
      if (this.btns.length <= 1) return;
      const idx = this.btns.indexOf(this.activeBtn);

      this.activeBtn.parentNode.removeChild(this.activeBtn);
      this.btns.splice(idx, 1);
      this.colors.splice(idx, 1);

      const other = this.btns[Math.min(this.btns.length - 1, idx)];

      this.activeBtn = other;
      this.refreshActive();
    },

    refreshActive: function() {
      this.el.querySelectorAll(".active").forEach(it => it.classList.remove("active"));
        this.activeBtn.classList.add("active");
        this.active = this.activeBtn.dataset.color;
        this.activeR = hex2R(this.active);
        this.activeG = hex2G(this.active);
        this.activeB = hex2B(this.active);

      // show
    },
    randomize: function() {
      if (this.isLocked) return;
      if (!this.btns) return;
      const idx = parseInt(this.colors.length * Math.random());
      this.active = this.colors[idx];
      this.activeBtn = this.btns[idx];
      this.refreshActive();

      this.colorComponent.set(this.active);

      this.activeR = hex2R(this.active);
      this.activeG = hex2G(this.active);
      this.activeB = hex2B(this.active);
    }
  };
  return Pal.all[key];
}
Pal.renderAll = () => Object.values(Pal.all).forEach((it) => it.render());

const palBody = Pal("eyes", "#palBody");
const palEyes = Pal("body", "#palEyes");
const palHair = Pal("hair", "#palHair");
const palSuit = Pal("suit", "#palSuit");
const palItem = Pal("item", "#palItem");

const b64ImagesCache = {};

const Parts = {
  uuid: 0x72, // If you read this: Have a nice day! :)
  heads: [],
  faces: [],
  els: {
    heads: $("#sliderHeads"),
    faces: $("#sliderFaces"),
    bases: $("#sliderBases"),
  },
  reset: function() {
    Object.values(this.els).forEach(it => (it.max = 0));
  },

  _load: (file, fn) => file.async("base64").then((b64) => b64_to_img(b64, fn)),

  addFace: function(file) {
    this._load(file, (img) => {
      this.facesImg = img;
      b64ImagesCache.faces = img2b64(img);
      this.els.faces.max = parseInt(img.width / Conf.data.w) - 1;
      randomizeAllMaybe();
    });
  },
  addHead: function(file) {
    this._load(file, (img) => {
      this.headsImg = img;
      b64ImagesCache.heads = img2b64(img);
      this.els.heads.max = parseInt(img.width / Conf.data.w) - 1;
      randomizeAllMaybe();
    });
  },
  addBase: function(file) {
    this._load(file, (img) => {
      this.baseImg = img;
      b64ImagesCache.base = img2b64(img);
      this.els.bases.max = parseInt(img.height / Conf.data.h) - 1; // note: h!
      randomizeAllMaybe();
    });
  },
}

const onslide = (el, fn) => {
  el.addEventListener("change", () => fn(+el.value));
  el.addEventListener("input", () => fn(+el.value));
}

onslide(Parts.els.bases, (val) => (State.base = val));
onslide(Parts.els.heads, (val) => (State.head = val));
onslide(Parts.els.faces, (val) => (State.face = val));

// damn not sure why but it's kinda broken on windows (even the same browser O.o)
const isSame = (x, y) => x === y || x === y-1 || x === y+1;

const isAboutSameRgb = (col, r, g, b) => isSame(col[0], r) && isSame(col[1], g) && isSame(col[2], b);

const Canvas = {
  c: $("#c"),
  ctx: $("#c").getContext("2d"),
  scale: 10,
  w: 16,
  h: 24,
  clear: function(ctx) { ctx.clearRect(0, 0, this.w, this.h); },
  reset: function() {
    this.c.width = this.w;
    this.c.height = this.h;
    this.c.style.width = (this.w * this.scale) + "px";
    this.c.style.height = (this.h * this.scale) + "px";
  },

  blit: function(ctx, img, x, y)
  {
    if (!img || typeof(img) === "number") return;
    ctx.drawImage(img, x, y);
  },

  blitAll: function(ctx, frame, animName) {
    this.clear(ctx);

    this.blit(ctx, Parts.baseImg,
      -State.getAnimX0(animName, frame) * Conf.getW(),
      -State.base * Conf.getH()
    );

    this.blit(ctx, Parts.headsImg,
      -State.head * Conf.getW(),
      Conf.getOy("head", animName, frame)
    );

    this.blit(ctx, Parts.facesImg,
      -State.face * Conf.getW(),
      Conf.getOy("face", animName, frame)
    );

    this.recolor(ctx);
  },

  recolor: function(ctx) {
    var imd = ctx.getImageData(0, 0, this.w, this.h);
    var data = imd.data;

    const fc = Conf.data.fromColors;
    if (!fc) return;

    for (let i=0; i<data.length*4; i+=4)
    {
      const _r = data[i+0];
      const _g = data[i+1];
      const _b = data[i+2];

      // outline
      if (isAboutSameRgb(fc.outline, data[i+0], data[i+1], data[i+2])) {
        data[i+0] = Conf.data.outlineColor[0];
        data[i+1] = Conf.data.outlineColor[1];
        data[i+2] = Conf.data.outlineColor[2];
      }


      // eyes
      else if (isAboutSameRgb(fc.eyes, data[i+0], data[i+1], data[i+2])) {
        data[i+0] = Pal.all.eyes.activeR;
        data[i+1] = Pal.all.eyes.activeG;
        data[i+2] = Pal.all.eyes.activeB;
      }

      // skin
      else if (isAboutSameRgb(fc.skin, data[i+0], data[i+1], data[i+2])) {
        data[i+0] = Pal.all.body.activeR;
        data[i+1] = Pal.all.body.activeG;
        data[i+2] = Pal.all.body.activeB;
      }

      else if (isAboutSameRgb(fc.skin2, data[i+0], data[i+1], data[i+2])) {
        data[i+0] = parseInt(Pal.all.body.activeR * Conf.shadowBody());
        data[i+1] = parseInt(Pal.all.body.activeG * Conf.shadowBody());
        data[i+2] = parseInt(Pal.all.body.activeB * Conf.shadowBody());
      }

      // hair
      else if (isAboutSameRgb(fc.hair, data[i+0], data[i+1], data[i+2])) {
        data[i+0] = Pal.all.hair.activeR;
        data[i+1] = Pal.all.hair.activeG;
        data[i+2] = Pal.all.hair.activeB;
      }
      else if (isAboutSameRgb(fc.hair2, data[i+0], data[i+1], data[i+2])) {
        data[i+0] = parseInt(Pal.all.hair.activeR * Conf.shadowHair());
        data[i+1] = parseInt(Pal.all.hair.activeG * Conf.shadowHair());
        data[i+2] = parseInt(Pal.all.hair.activeB * Conf.shadowHair());
      }

      // item
      else if (isAboutSameRgb(fc.item, data[i+0], data[i+1], data[i+2])) {
        data[i+0] = Pal.all.item.activeR;
        data[i+1] = Pal.all.item.activeG;
        data[i+2] = Pal.all.item.activeB;
      }
      else if (isAboutSameRgb(fc.item2, data[i+0], data[i+1], data[i+2])) {
        data[i+0] = parseInt(Pal.all.item.activeR * Conf.shadowItem());
        data[i+1] = parseInt(Pal.all.item.activeG * Conf.shadowItem());
        data[i+2] = parseInt(Pal.all.item.activeB * Conf.shadowItem());
      }

      // suit
      else if (isAboutSameRgb(fc.suit, data[i+0], data[i+1], data[i+2])) {
        data[i+0] = Pal.all.suit.activeR;
        data[i+1] = Pal.all.suit.activeG;
        data[i+2] = Pal.all.suit.activeB;
      }
      else if (isAboutSameRgb(fc.suit2, data[i+0], data[i+1], data[i+2])) {
        data[i+0] = parseInt(Pal.all.suit.activeR * Conf.shadowSuit());
        data[i+1] = parseInt(Pal.all.suit.activeG * Conf.shadowSuit());
        data[i+2] = parseInt(Pal.all.suit.activeB * Conf.shadowSuit());
      }
    }

    ctx.putImageData(imd, 0, 0);
  }
};

Canvas.reset();

const step = () => {
  const f = parseInt((Date.now() / 110));
  //$("#debug").innerText = f % 4;
  Canvas.blitAll(Canvas.ctx, State.modF(f), State.anim);
  window.requestAnimationFrame(step);
}

(() => {
  const btn = $("#animbtn");
  btn.addEventListener("click", () => {
    if (State.anim == "no") { State.anim = "idle"; }
    else if (State.anim == "idle") { State.anim = "run"; }
    else { State.anim = "no"; }
    btn.innerText = "anim: " + State.anim;
  });
})();


(() => {
  const btn = $("#scalebtn");
  btn.addEventListener("click", () => {
    if (Canvas.scale >= 16) Canvas.scale = 4
    else Canvas.scale += 2;
    btn.innerText = "×" + Canvas.scale;
    Canvas.reset();
  });
})();



const rndSlider = (el) => (el.value = parseInt(Math.random() * (+el.max + 1)));

const randomizeAll = () => {
  if(!$("#lockBases").checked) rndSlider(Parts.els.bases);
  if(!$("#lockHeads").checked) rndSlider(Parts.els.heads);
  if(!$("#lockFaces").checked) rndSlider(Parts.els.faces);

  Object.values(Pal.all).forEach(pal => pal.randomize());

  for (let i=0; i<10; i++) {
    if (Pal.all.eyes.active !== Pal.all.body.active) break;
    Pal.all.eyes.randomize();
  }

  State.readFromUi();
};

const randomizeAllMaybe = () => { try { randomizeAll() } catch(e) {} };

$("#randomize").addEventListener("click", randomizeAll);


const exportAll = (useZip) => {
  const canvas = document.createElement("canvas");
  canvas.width = Conf.getW();
  canvas.height = Conf.getH();
  const ctx = canvas.getContext("2d");

  let count = 0;
  const zip = new JSZip();

  const canvasSprite = document.createElement("canvas");
  canvasSprite.width = Conf.getW() * 4;
  canvasSprite.height = Conf.getH() * 3;
  const ctxSprite = canvasSprite.getContext("2d");

  const done = () => {
    if (count > 0) return;

    canvasSprite.toBlob((blob) => {
      if (useZip) {
        zip.file("sprite.png", blob);
        zip.generateAsync({type:"base64"}).then((base64) => {
          window.location = "data:application/zip;base64," + base64;
        }, (err) => {
          throw new Error("cannot generate ZIP: " + err);
        });
      } else {
        saveAs(blob, "sprite.png");
      }
    });
  }

  const one = (spriteY, fName, anim, frame) => {
    Canvas.clear(ctx);
    Canvas.blitAll(ctx, frame, anim);

    const spriteX = frame;
    ctxSprite.drawImage(canvas, spriteX * Conf.getW(), spriteY * Conf.getH());

    count++;
    canvas.toBlob((blob) => {
      zip.file(fName, blob);
      count--;
      done();
    });
  }

  one(0, "no_anim_0.png", "no", 0);
  one(1, "idle_0.png", "idle", 0);
  one(1, "idle_1.png", "idle", 1);
  one(1, "idle_2.png", "idle", 2);
  one(1, "idle_3.png", "idle", 3);
  one(2, "run_0.png", "run", 0);
  one(2, "run_1.png", "run", 1);
  one(2, "run_2.png", "run", 2);
  one(2, "run_3.png", "run", 3);

  // TODO....
};

$("#exportzipbtn").addEventListener("click", () => exportAll(true));
$("#exportspritebtn").addEventListener("click", () => exportAll(false));

(() => {
  const $say = $("#say");
  let id = -1;

  const rlt = (txt) => {
    const a = document.createElement("div");
    a.dir = "rtl";
    a.innerText = txt;
    return a;
  };

  const ltr = (txt) => (txt);

  const tbrl = (txt) => {
    const a = document.createElement("div");
    a.style.writingMode = "tb-rl";
    a.innerText = txt;
    return a;
  };

  const ws = [
    rlt("السلام عليكم"),
    tbrl("你好"),
    ltr("Hello!"),
    ltr("Salut!"),
    ltr("Привет!"),
    ltr("¡Hola!"),
    ltr("नमस्ते"),
    ltr("नमस्कार"),
    ltr("Hi!"),
    ltr("Oi!"),
    tbrl("今日は"),
    ltr("Hallo!"),
    ltr("toki!"),
  ];

  const what = () => {
    const idx = parseInt(ws.length * Math.random());
    return ws[idx];
  }

  const C = $("#c")
  C.addEventListener("click", () => {
    window.clearTimeout(id);
    $say.innerText = "";
    const w = what();
    console.log(w);
    $say.append(w);
    $say.style.marginLeft = parseInt(Math.random() * 50 - 25) + "px";
    if (w.dir == "rtl") {
      C.style.transform = "scale(-1, 1)"
      // $say.style.left = "auto";
      // $say.style.right = "50%";
    } else {
      C.style.transform = "scale(1, 1)"
      // $say.style.left = "50%";
      // $say.style.right = "auto";
      // $say.style.marginLeft = parseInt(Math.random() * 50 - 25) + "px";
    }
    $say.style.marginTop= parseInt(Math.random() * 20 - 10) + "px";
    id = window.setTimeout(() => {
      ($say.innerText="");
      C.style.transform = "scale(1, 1)";
    }, 2000);
  });

  $say.addEventListener("click", () => ($say.innerText = ""));

})();

window.requestAnimationFrame(step);


const sliderShadowModSetup = (id) => {
  const it = $("#slider_" + id)
  it.value = (Conf.data[id] * it.max);

  it.onchange = () => (Conf.data[id] = it.value / it.max);
  it.oninput = it.onchange;
}

const sliderShadowModsAllSetup = () => {
  sliderShadowModSetup("suitShadowMod");
  sliderShadowModSetup("itemShadowMod");
  sliderShadowModSetup("bodyShadowMod");
  sliderShadowModSetup("hairShadowMod");
}

$("#reset_shadows").addEventListener("click", () => {
  let a;
  a = $("#slider_suitShadowMod"); a.value = 8; a.onchange();
  a = $("#slider_itemShadowMod"); a.value = 8; a.onchange();
  a = $("#slider_bodyShadowMod"); a.value = 8; a.onchange();
  a = $("#slider_hairShadowMod"); a.value = 8; a.onchange();
});


const rgbOrHex2Hex = (rgbOrHex) => (rgbOrHex + "" === rgbOrHex)
    ? rgbOrHex
    : ("#" + pad2(rgbOrHex[0]) + pad2(rgbOrHex[1]) + pad2(rgbOrHex[2]));

const ColorComponent = (rgbOrHex, onchangeFn) => {
  const col = rgbOrHex2Hex(rgbOrHex);

  const $el = document.createElement("div");
  $el.className = "colorComponent";

  $el.classList.add("colorComponent");
  $el.innerHTML = `
    <input type=text class='hex' style='width: 80px;'>
    <input type=range min=0 max=255 class=r style='width:90px'>
    <input type=range min=0 max=255 class=g style='width:90px'>
    <input type=range min=0 max=255 class=b style='width:90px'>
  `;
  const $hex = $el.querySelector(".hex");

  const $r = $el.querySelector(".r");
  const $g = $el.querySelector(".g");
  const $b = $el.querySelector(".b");

  $r.value = parseInt(col[1] + col[2], 16);
  $g.value = parseInt(col[3] + col[4], 16);
  $b.value = parseInt(col[5] + col[6], 16);

  $hex.value = col;
  $hex.onchange = () => {
    let v = ("#" + $hex.value).replace(/^##/, "#").toLowerCase();

    if (v.match(/^#[0-9a-z][0-9a-z][0-9a-z]$/))
      v = "#" +v[1] +v[1] +v[2] +v[2] +v[3] +v[3];

    if (! v.match(/^#[0-9a-z][0-9a-z][0-9a-z][0-9a-z][0-9a-z][0-9a-z]$/))
      v = "#000000";

    let r = parseInt(v[1] + v[2], 16);
    let g = parseInt(v[3] + v[4], 16);
    let b = parseInt(v[5] + v[6], 16);

    $r.value = r;
    $g.value = g;
    $b.value = b;

    $hex.value = "#" +v[1] +v[2] +v[3] +v[4] +v[5] +v[6];

    onchangeFn([r, g, b], $hex.value);
  };

  const c = (elem) => pad2((+elem.value).toString(16))
  const onslide = () => {
    $hex.value = "#" + c($r) + c($g) + c($b);
    $hex.onchange();
  };
  $g.onchange = $g.oninput = onslide;
  $r.onchange = $r.oninput = onslide;
  $b.onchange = $b.oninput = onslide;

  return {
    el: $el,
    getHex: () => $hex.value,
    set: (hex) => {
      $hex.value = rgbOrHex2Hex(hex);
      $hex.onchange();
    },
    toggle: () => {
      $el.style.display = ($el.style.display === "none")
        ? "inline-block"
        : "none";
    },
  };
}


const setPalsUniform = (colors) => {
  Pal.all.eyes.setColors(colors.slice());
  Pal.all.body.setColors(colors.slice());
  Pal.all.hair.setColors(colors.slice());
  Pal.all.suit.setColors(colors.slice());
  Pal.all.item.setColors(colors.slice());
}

$("#set_pal_cc29").onclick = () => {
  setPalsUniform(["#f2f0e5", "#b8b5b9", "#868188", "#646365", "#45444f", "#3a3858","#352b42", "#43436a", "#4b80ca", "#68c2d3", "#a2dcc7", "#ede19e", "#d3a068", "#b45252", "#6a536e", "#4b4158", "#80493a", "#a77b5b", "#e5ceb4", "#c2d368", "#8ab060", "#567b79", "#4e584a", "#7b7243", "#b2b47e", "#edc8c4", "#cf8acb", "#5f556a",]);

  outlineColorComponent.set("#212123");
}

$("#set_pal_endesga32").onclick = () => {

  setPalsUniform([ "#be4a2f", "#d77643", "#ead4aa", "#e4a672", "#b86f50", "#733e39", "#3e2731", "#a22633", "#e43b44", "#f77622", "#feae34", "#fee761", "#63c74d", "#3e8948", "#265c42", "#193c3e", "#124e89", "#0099db", "#2ce8f5", "#ffffff", "#c0cbdc", "#8b9bb4", "#5a6988", "#3a4466", "#262b44", "#181425", "#ff0044", "#68386c", "#b55088", "#f6757a", "#e8b796", "#c28569", ]);

  outlineColorComponent.set("#181425");
};


$("#set_pal_pdm1").onclick = () => {
  Pal.all.eyes.setColors([ "#222033","#178178","#7722ab","#346524","#5a8ca6","#fafafa","#ababab","#751f20" ]);
  Pal.all.body.setColors([ "#cccc77", "#f0f0dd", "#ccccbe", "#e6d1bc", "#cb9f76", "#a47d5b", "#7a3333", "#686e46", "#dcb641", "#72b8e4", "#aa4951", "#887777", "#434343", "#6cb832" ]);
  Pal.all.item.setColors([ "#ccaa44", "#d04648", "#a9b757", "#f0f0dd", "#944a9c", "#447ccf", "#3e3e3e" ]);
  Pal.all.suit.setColors([ "#ccaa44", "#d04648", "#a9b757", "#f0f0dd", "#944a9c", "#447ccf", "#3e3e3e" ]);
  Pal.all.hair.setColors([ "#ebebeb", "#e4da99", "#b62f31", "#cc7733", "#4d4e4c" ]);

  outlineColorComponent.set("#222134");
};


$("#set_pal_zughy32").onclick = () => {

  setPalsUniform([ "#472d3c", "#5e3643", "#7a444a", "#a05b53", "#bf7958", "#eea160", "#f4cca1", "#b6d53c", "#71aa34", "#397b44", "#3c5956", "#5a5353", "#7d7071", "#a0938e", "#cfc6b8", "#dff6f5", "#8aebf1", "#28ccdf", "#3978a8", "#394778", "#39314b", "#564064", "#8e478c", "#cd6093", "#ffaeb6", "#f4b41b", "#f47e1b", "#e6482e", "#a93b3b", "#827094", "#4f546b", ]);

  outlineColorComponent.set("#302c2e");
};

$("#set_pal_vinik24").onclick = () => {
  setPalsUniform(["#6f6776", "#9a9a97", "#c5ccb8", "#8b5580", "#c38890", "#a593a5", "#666092", "#9a4f50", "#c28d75", "#7ca1c0", "#416aa3", "#8d6268", "#be955c", "#68aca9", "#387080", "#6e6962", "#93a167", "#6eaa78", "#557064", "#9d9f7f", "#7e9e99", "#5d6872", "#433455", ]);

  outlineColorComponent.set("#000000");
};


$("#set_pal_steam_lords").onclick = () => {
  setPalsUniform([ "#213b25", "#3a604a", "#4f7754", "#a19f7c", "#77744f", "#775c4f", "#603b3a", "#3b2137", "#2f213b", "#433a60", "#4f5277", "#65738c", "#7c94a1", "#a0b9ba", "#c0d1cc", ]);

  outlineColorComponent.set("#170e19");
};


$("#set_pal_island_joy_16").onclick = () => {
  setPalsUniform([ "#ffffff", "#6df7c1", "#11adc1", "#606c81", "#1e8875", "#5bb361", "#a1e55a", "#f7e476", "#f99252", "#cb4d68", "#6a3771", "#c92464", "#f48cb6", "#f7b69e", "#9b9c82", ]);

  outlineColorComponent.set("#393457");
};


$("#exportconfig").onclick =  () => {
  const zip = new JSZip();

  const c = JSON.parse(JSON.stringify(Conf.data));


  c.version = 2;
  c.outlineColor = hex2Arr(outlineColorComponent.getHex());

  // pals - keep in conf?

  c.pals.eyes = Pal.all.eyes.colors;
  c.pals.body = Pal.all.body.colors;
  c.pals.hair = Pal.all.hair.colors;
  c.pals.item = Pal.all.item.colors;
  c.pals.suit = Pal.all.suit.colors;

  zip.file("conf.json", JSON.stringify(c, null, 2));
  zip.file("base.png", b64ImagesCache.base, { base64: true });
  zip.file("heads.png", b64ImagesCache.heads, { base64: true });
  zip.file("faces.png", b64ImagesCache.faces, { base64: true });

  zip.generateAsync({ type:"blob" }).then((blob) => saveAs(blob, "pixel_dudes_config.zip"));
}


