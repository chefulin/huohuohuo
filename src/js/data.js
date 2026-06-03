/**
 * data.js v2 — 后端API + localStorage缓存双通道
 * 后端可用时走API，不可用时fallback到localStorage
 */
(function(window) {
  'use strict';

  var API = 'http://localhost:5050';
  var ONLINE = false;

  function api(url, opts) {
    opts = opts || {};
    return fetch(API + url, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function(r) { return r.json(); });
  }

  // 启动时检测后端
  function checkOnline() {
    return api('/api/admin/stats').then(function(r) {
      ONLINE = r.success;
      return ONLINE;
    }).catch(function() {
      ONLINE = false;
      return false;
    });
  }

  // ============================================================
  // localStorage 辅助（作为缓存层）
  // ============================================================
  var LS = {
    get: function(k) { try { return JSON.parse(localStorage.getItem(k)); } catch(e) { return null; } },
    set: function(k,v) { localStorage.setItem(k, JSON.stringify(v)); },
    remove: function(k) { localStorage.removeItem(k); }
  };

  var CACHE = {
    users: function() { return LS.get('huoqi_users_cache') || []; },
    setUsers: function(u) { LS.set('huoqi_users_cache', u); },
    addUser: function(u) { var all = this.users(); var idx = all.findIndex(function(x){return x.id===u.id}); if(idx>=0) all[idx]=u; else all.push(u); this.setUsers(all); },
    updateUser: function(uid, fields) { var all = this.users(); var idx = all.findIndex(function(x){return x.id===uid}); if(idx>=0) { Object.assign(all[idx], fields); this.setUsers(all); } },
    currentId: function() { return LS.get('huoqi_current_user'); },
    setCurrentId: function(id) { LS.set('huoqi_current_user', id); }
  };

  // ============================================================
  // UserDB — 注册/登录走API，读取走缓存
  // ============================================================
  var UserDB = {
    all: function() {
      return CACHE.users();
    },
    findById: function(id) {
      return CACHE.users().find(function(u) { return u.id === id; }) || null;
    },
    findByPhone: function(phone) {
      return CACHE.users().find(function(u) { return u.phone === phone; }) || null;
    },

    register: function(phone, password, nickname, avatar) {
      var self = this;
      return api('/api/register', { method: 'POST', body: {
        phone: phone, password: password,
        nickname: nickname || undefined, avatar: avatar || '😊'
      }}).then(function(res) {
        if (!res.success) return res;
        CACHE.addUser(res.user);
        CACHE.setCurrentId(res.user.id);
        return res;
      }).catch(function() {
        // Fallback: localStorage
        var users = LS.get('huoqi_users') || [];
        if (users.find(function(u) { return u.phone === phone; })) {
          return { success: false, error: '该手机号已注册' };
        }
        var nu = {
          id: 'U' + Date.now().toString(36).toUpperCase(),
          phone: phone, password: password,
          nickname: nickname || ('用户' + phone.slice(-4)),
          avatar: avatar || '😊', avatarFrame: 'default',
          anger: 0, tolerance: 0, title: '',
          registerDate: new Date().toISOString().split('T')[0],
          dailyTolerance: {}, createdAt: Date.now()
        };
        users.push(nu);
        LS.set('huoqi_users', users);
        CACHE.setCurrentId(nu.id);
        return { success: true, user: nu };
      });
    },

    login: function(phone, password) {
      return api('/api/login', { method: 'POST', body: { phone: phone, password: password } })
      .then(function(res) {
        if (!res.success) return res;
        CACHE.addUser(res.user);
        CACHE.setCurrentId(res.user.id);
        // 同步拉取好友等缓存
        return syncAll(res.user.id).then(function() { return res; });
      }).catch(function() {
        var users = LS.get('huoqi_users') || [];
        var user = users.find(function(u) { return u.phone === phone && u.password === password; });
        if (!user) return { success: false, error: '手机号或密码错误' };
        CACHE.setCurrentId(user.id);
        return { success: true, user: user };
      });
    },

    current: function() {
      var uid = CACHE.currentId();
      if (!uid) return null;
      return this.findById(uid);
    },

    update: function(uid, fields) {
      CACHE.updateUser(uid, fields);
      if (ONLINE) {
        api('/api/user/' + uid, { method: 'PUT', body: fields });
      }
      return true;
    },

    logout: function() {
      CACHE.setCurrentId(null);
    },

    search: function(keyword) {
      if (ONLINE) {
        return api('/api/user/search?q=' + encodeURIComponent(keyword)).then(function(res) {
          return res.users || [];
        });
      }
      // Fallback
      return Promise.resolve((LS.get('huoqi_users') || []).filter(function(u) {
        return u.phone === keyword || u.id === keyword;
      }).map(function(u) {
        return { id: u.id, nickname: u.nickname, avatar: u.avatar, avatarFrame: u.avatarFrame, anger: u.anger, tolerance: u.tolerance };
      }));
    }
  };

  // ============================================================
  // 数据同步
  // ============================================================
  function syncAll(uid) {
    if (!ONLINE) return Promise.resolve();
    return Promise.all([
      api('/api/friends/' + uid).then(function(r) {
        if (r.friends) { r.friends.forEach(function(f) { CACHE.addUser(f); }); LS.set('huoqi_friends_cache_' + uid, r.friends.map(function(f) { return f.id; })); }
      }),
      api('/api/friends/requests/' + uid).then(function(r) {
        if (r.requests) LS.set('huoqi_requests_cache_' + uid, r.requests);
      })
    ]);
  }

  // ============================================================
  // FriendDB
  // ============================================================
  var FriendDB = {
    getFriends: function(uid) {
      if (ONLINE) {
        var cached = CACHE.users().filter(function(u) {
          var fids = LS.get('huoqi_friends_cache_' + uid) || [];
          return fids.indexOf(u.id) >= 0;
        });
        return cached;
      }
      var data = LS.get('huoqi_friends') || {};
      var fids = data[uid] || [];
      return fids.map(function(id) { return UserDB.findById(id); }).filter(Boolean);
    },

    isFriend: function(a, b) {
      var fids = LS.get('huoqi_friends_cache_' + a) || [];
      return fids.indexOf(b) >= 0;
    },

    addFriend: function(a, b) {
      var fa = LS.get('huoqi_friends_cache_' + a) || [];
      if (fa.indexOf(b) < 0) { fa.push(b); LS.set('huoqi_friends_cache_' + a, fa); }
      var fb = LS.get('huoqi_friends_cache_' + b) || [];
      if (fb.indexOf(a) < 0) { fb.push(a); LS.set('huoqi_friends_cache_' + b, fb); }
    }
  };

  // ============================================================
  // RequestDB
  // ============================================================
  var RequestDB = {
    send: function(from, to) {
      if (ONLINE) return api('/api/friends/request', { method:'POST', body:{from:from,to:to} });
      var data = LS.get('huoqi_friend_requests') || {};
      if (!data[to]) data[to] = [];
      if (data[to].find(function(r) { return r.from === from && r.status === 'pending'; }))
        return Promise.resolve({ success: false, error: '已发送过申请' });
      data[to].push({ from: from, to: to, status: 'pending', timestamp: Date.now() });
      LS.set('huoqi_friend_requests', data);
      return Promise.resolve({ success: true });
    },

    getPending: function(uid) {
      var cached = LS.get('huoqi_requests_cache_' + uid) || [];
      return cached;
    },

    respond: function(to, from, action) {
      if (ONLINE) return api('/api/friends/respond', { method:'POST', body:{from:from,to:to,action:action} }).then(function(r) {
        if (action === 'accept') FriendDB.addFriend(from, to);
        LS.remove('huoqi_requests_cache_' + to);
        return r;
      });
      var data = LS.get('huoqi_friend_requests') || {};
      var list = data[to] || [];
      var req = list.find(function(r) { return r.from === from && r.status === 'pending'; });
      if (!req) return Promise.resolve({ success: false, error: '申请不存在' });
      req.status = action === 'accept' ? 'accepted' : 'rejected';
      LS.set('huoqi_friend_requests', data);
      if (action === 'accept') FriendDB.addFriend(from, to);
      return Promise.resolve({ success: true });
    }
  };

  // ============================================================
  // ValueEngine
  // ============================================================
  var ValueEngine = {
    clickAvatar: function(opId, tgtId) {
      var op = UserDB.findById(opId) || {};
      var tgt = UserDB.findById(tgtId) || {};
      if (ONLINE) {
        return api('/api/action/click', { method:'POST', body:{operator:opId, target:tgtId} }).then(function(r) {
          if (r.success) {
            CACHE.updateUser(opId, { tolerance: r.operatorTolerance });
            CACHE.updateUser(tgtId, { anger: Math.max(0, (tgt.anger||0) + (r.effect==='hit'?1:-1)) });
          }
          return r;
        });
      }
      // Fallback
      var angerChange = (op.anger||0) >= 999 ? -1 : 1;
      var effect = angerChange === 1 ? 'hit' : 'love';
      CACHE.updateUser(tgtId, { anger: Math.max(0, (tgt.anger||0) + angerChange) });
      CACHE.updateUser(opId, { tolerance: (op.tolerance||0) + 1 });
      return Promise.resolve({ success: true, effectType: effect, operatorNewTolerance: (op.tolerance||0)+1 });
    },

    longPressAvatar: function(opId, tgtId) {
      var op = UserDB.findById(opId) || {};
      var tgt = UserDB.findById(tgtId) || {};
      if (ONLINE) {
        return api('/api/action/longpress', { method:'POST', body:{operator:opId, target:tgtId} }).then(function(r) {
          if (r.success) {
            CACHE.updateUser(opId, { tolerance: r.operatorTolerance });
            CACHE.updateUser(tgtId, { anger: Math.max(0, (tgt.anger||0) - 1) });
          }
          return r;
        });
      }
      CACHE.updateUser(tgtId, { anger: Math.max(0, (tgt.anger||0) - 1) });
      CACHE.updateUser(opId, { tolerance: (op.tolerance||0) + 1 });
      return Promise.resolve({ success: true, effectType: 'love', operatorNewTolerance: (op.tolerance||0)+1 });
    }
  };

  // ============================================================
  // ChatDB
  // ============================================================
  var ChatDB = {
    getMessages: function(a, b) {
      if (ONLINE) {
        return api('/api/chat/' + a + '/' + b).then(function(r) {
          LS.set('huoqi_chat_' + [a,b].sort().join('_'), r.messages || []);
          return r.messages || [];
        });
      }
      var key = 'huoqi_chat_' + [a,b].sort().join('_');
      return Promise.resolve(LS.get(key) || []);
    },

    send: function(from, to, text) {
      if (ONLINE) return api('/api/chat/send', { method:'POST', body:{from:from, to:to, text:text} });
      var key = 'huoqi_chat_' + [from,to].sort().join('_');
      var msgs = LS.get(key) || [];
      msgs.push({ from: from, to: to, text: text, timestamp: Date.now() });
      LS.set(key, msgs);
      return Promise.resolve({ success: true });
    },

    clear: function(a, b) {
      LS.remove('huoqi_chat_' + [a,b].sort().join('_'));
    }
  };

  // ============================================================
  // WeeklyEngine
  // ============================================================
  var WeeklyEngine = {
    getCurrentWeek: function() {
      var now = new Date();
      var day = now.getDay();
      var monday = new Date(now);
      monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
      var dates = [];
      for (var i = 0; i < 7; i++) { var d = new Date(monday); d.setDate(monday.getDate() + i); dates.push(d.toISOString().split('T')[0]); }
      return { monday: dates[0], sunday: dates[6], dates: dates };
    },

    checkWeeklyQualify: function(uid) {
      var user = UserDB.findById(uid);
      if (!user) return false;
      var week = this.getCurrentWeek();
      var daily = user.dailyTolerance || {};
      return week.dates.every(function(d) { return (daily[d] || 0) >= 999; });
    },

    getQualifiedUsers: function() {
      var self = this;
      return CACHE.users().filter(function(u) { return self.checkWeeklyQualify(u.id); })
        .sort(function(a, b) { return (b.tolerance||0) - (a.tolerance||0); })
        .map(function(u) { return { id: u.id, nickname: u.nickname, tolerance: u.tolerance, avatar: u.avatar, avatarFrame: u.avatarFrame, title: '最值得交往的朋友' }; });
    }
  };

  // ============================================================
  // ShopEngine
  // ============================================================
  var ShopEngine = {
    items: [
      { id: 'frame_calm', name: '心如止水', cost: 200, frameClass: 'calm', emoji: '🪷', desc: '水流莲花·心澄如镜' },
      { id: 'frame_bamboo', name: '虚怀若竹', cost: 280, frameClass: 'bamboo', emoji: '🎋', desc: '翠竹清风·谦谦君子' },
      { id: 'frame_capybara', name: '卡皮巴拉', cost: 350, frameClass: 'capybara', emoji: '🦫', desc: '淡定水豚·情绪稳定' },
      { id: 'frame_cloud', name: '云淡风轻', cost: 420, frameClass: 'cloud', emoji: '☁️', desc: '飘逸白云·宠辱不惊' },
      { id: 'frame_master', name: '包容大师', cost: 500, frameClass: 'master', emoji: '🌊', desc: '海纳百川·有容乃大' },
      { id: 'frame_smile', name: '弥勒笑颜', cost: 650, frameClass: 'smile', emoji: '😊', desc: '慈眉善目·笑口常开' },
      { id: 'frame_zen', name: '上善若水', cost: 999, frameClass: 'zen', emoji: '💧', desc: '终极形态·水滴石穿' }
    ],
    canAccess: function(uid) {
      return (UserDB.findById(uid) || {}).tolerance >= 999;
    },
    purchase: function(uid, itemId) {
      var user = UserDB.findById(uid);
      if (!user) return Promise.resolve({ success: false, error: '用户不存在' });
      var item = this.items.find(function(i) { return i.id === itemId; });
      if (!item) return Promise.resolve({ success: false, error: '商品不存在' });
      if (user.tolerance < item.cost) return Promise.resolve({ success: false, error: '包容值不足' });
      if (user.avatarFrame === item.frameClass) return Promise.resolve({ success: false, error: '已拥有' });
      if (ONLINE) return api('/api/shop/purchase', { method:'POST', body:{userId:uid, itemId:itemId} }).then(function(r) {
        if (r.success) CACHE.updateUser(uid, { tolerance: user.tolerance - item.cost, avatarFrame: item.frameClass });
        return r;
      });
      CACHE.updateUser(uid, { tolerance: user.tolerance - item.cost, avatarFrame: item.frameClass });
      return Promise.resolve({ success: true });
    }
  };

  // ============================================================
  // 排行榜 (必须走API)
  // ============================================================
  var RankAPI = {
    getRankings: function(type) {
      if (ONLINE) return api('/api/rankings?type=' + type).then(function(r) { return r.users || []; });
      var users = CACHE.users();
      users.sort(function(a,b) { return (b[type]||0) - (a[type]||0); });
      return Promise.resolve(users);
    },
    getRecommend: function() {
      if (ONLINE) return api('/api/recommend').then(function(r) { return r; });
      return Promise.resolve({ users: WeeklyEngine.getQualifiedUsers(), week: WeeklyEngine.getCurrentWeek() });
    }
  };

  // 降火贴士
  var CoolDownTips = [
    '🥒 来碗丝瓜汤，清热降火，一身轻松',
    '🍵 泡杯菊花茶，静心养性，怒气消散',
    '🧘 闭上眼睛深呼吸3次，让火气随风而去',
    '🚶 出门散步10分钟，换个心情再回来',
    '🎵 听一首治愈音乐，让心静下来',
    '📿 莫生气莫生气，气出病来无人替',
    '🌿 点一炷檀香，让烟雾带走你的火气',
    '🛁 泡个热水澡，把烦恼和火气一起泡走',
    '😌 原谅别人，就是善待自己',
    '💚 每一点包容，都会让世界更温柔'
  ];
  function getRandomTip() { return CoolDownTips[Math.floor(Math.random() * CoolDownTips.length)]; }

  // ============================================================
  // 全局导出 (保持接口不变)
  // ============================================================
  window.HQ = {
    UserDB: UserDB,
    FriendDB: FriendDB,
    RequestDB: RequestDB,
    ValueEngine: ValueEngine,
    ChatDB: ChatDB,
    WeeklyEngine: WeeklyEngine,
    ShopEngine: ShopEngine,
    RankAPI: RankAPI,
    getRandomTip: getRandomTip,
    LS: LS,
    checkOnline: checkOnline,
    syncAll: syncAll,
    isOnline: function() { return ONLINE; },
    API: API
  };

})(window);
