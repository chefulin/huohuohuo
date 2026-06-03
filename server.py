"""
火气很大 H5 — 后端服务
Python Flask + SQLite
启动: py server.py
"""
import json, sqlite3, time, os
from datetime import datetime, timedelta
from flask import Flask, request, jsonify, g, send_from_directory
from flask_cors import CORS

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SRC_DIR = os.path.join(BASE_DIR, 'src')

app = Flask(__name__, static_folder=SRC_DIR, static_url_path='/static')
CORS(app)

DB_PATH = os.path.join(BASE_DIR, 'huoqi.db')

# ============================================================
# 数据库
# ============================================================
def get_db():
    if 'db' not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA journal_mode=WAL")
    return g.db

@app.teardown_appcontext
def close_db(e):
    db = g.pop('db', None)
    if db: db.close()

def init_db():
    db = sqlite3.connect(DB_PATH)
    db.executescript('''
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY, phone TEXT UNIQUE, password TEXT, nickname TEXT,
            avatar TEXT DEFAULT '😊', avatarFrame TEXT DEFAULT 'default',
            anger INTEGER DEFAULT 0, tolerance INTEGER DEFAULT 0,
            title TEXT DEFAULT '', registerDate TEXT, dailyTolerance TEXT DEFAULT '{}',
            createdAt REAL
        );
        CREATE TABLE IF NOT EXISTS friends (
            user_a TEXT, user_b TEXT,
            PRIMARY KEY (user_a, user_b)
        );
        CREATE TABLE IF NOT EXISTS friend_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            from_user TEXT, to_user TEXT, status TEXT DEFAULT 'pending',
            created_at REAL
        );
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            from_user TEXT, to_user TEXT, text TEXT, timestamp REAL
        );
    ''')
    db.commit()
    db.close()

init_db()

# ============================================================
# 工具
# ============================================================
def row_to_dict(row):
    return dict(row) if row else None

def rows_to_list(rows):
    return [dict(r) for r in rows]

def get_week_range():
    now = datetime.now()
    monday = now - timedelta(days=now.weekday())
    return [(monday + timedelta(days=i)).strftime('%Y-%m-%d') for i in range(7)]

# ============================================================
# 用户 API
# ============================================================
@app.route('/api/register', methods=['POST'])
def register():
    data = request.get_json()
    phone = data.get('phone','').strip()
    password = data.get('password','')
    nickname = data.get('nickname','') or ('用户'+phone[-4:])
    avatar = data.get('avatar','😊')
    if not phone or not password:
        return jsonify({'success':False,'error':'手机号和密码不能为空'})
    db = get_db()
    if db.execute("SELECT id FROM users WHERE phone=?",(phone,)).fetchone():
        return jsonify({'success':False,'error':'该手机号已注册'})
    uid = 'U' + str(int(time.time()*1000))[-8:] + str(int(time.time()*1000))[-4:]
    now = datetime.now().strftime('%Y-%m-%d')
    db.execute("INSERT INTO users (id,phone,password,nickname,avatar,avatarFrame,anger,tolerance,title,registerDate,dailyTolerance,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (uid, phone, password, nickname, avatar, 'default', 0, 0, '', now, '{}', time.time()))
    db.commit()
    user = row_to_dict(db.execute("SELECT * FROM users WHERE id=?",(uid,)).fetchone())
    return jsonify({'success':True,'user':user})

@app.route('/api/login', methods=['POST'])
def login():
    data = request.get_json()
    phone = data.get('phone','').strip()
    password = data.get('password','')
    db = get_db()
    user = row_to_dict(db.execute("SELECT * FROM users WHERE phone=? AND password=?",(phone,password)).fetchone())
    if not user:
        return jsonify({'success':False,'error':'手机号或密码错误'})
    return jsonify({'success':True,'user':user})

@app.route('/api/user/<uid>', methods=['GET','PUT'])
def user_api(uid):
    db = get_db()
    if request.method == 'GET':
        user = row_to_dict(db.execute("SELECT * FROM users WHERE id=?",(uid,)).fetchone())
        if not user: return jsonify({'success':False,'error':'用户不存在'}),404
        return jsonify({'success':True,'user':user})
    else:
        data = request.get_json()
        allowed = ['nickname','avatar','avatarFrame','anger','tolerance','title','dailyTolerance']
        updates = {k:data[k] for k in allowed if k in data}
        if updates:
            cols = ', '.join(f'{k}=?' for k in updates)
            vals = list(updates.values()) + [uid]
            db.execute(f"UPDATE users SET {cols} WHERE id=?", vals)
            db.commit()
        user = row_to_dict(db.execute("SELECT * FROM users WHERE id=?",(uid,)).fetchone())
        return jsonify({'success':True,'user':user})

@app.route('/api/user/search', methods=['GET'])
def search_user():
    kw = request.args.get('q','').strip()
    db = get_db()
    users = rows_to_list(db.execute(
        "SELECT id,phone,nickname,avatar,avatarFrame,anger,tolerance FROM users WHERE phone=? OR id=?",
        (kw, kw)).fetchall())
    return jsonify({'success':True,'users':users})

# ============================================================
# 好友 API
# ============================================================
@app.route('/api/friends/<uid>', methods=['GET'])
def get_friends(uid):
    db = get_db()
    rows = db.execute('''
        SELECT u.* FROM users u
        INNER JOIN friends f ON (f.user_a=? AND u.id=f.user_b) OR (f.user_b=? AND u.id=f.user_a)
    ''', (uid, uid)).fetchall()
    return jsonify({'success':True,'friends':rows_to_list(rows)})

@app.route('/api/friends/request', methods=['POST'])
def send_friend_request():
    data = request.get_json()
    from_u = data['from']
    to_u = data['to']
    db = get_db()
    # 检查是否已是好友
    existing = db.execute(
        "SELECT 1 FROM friends WHERE (user_a=? AND user_b=?) OR (user_a=? AND user_b=?)",
        (from_u, to_u, to_u, from_u)).fetchone()
    if existing: return jsonify({'success':False,'error':'已是好友'})
    # 检查是否有待处理申请
    pending = db.execute(
        "SELECT 1 FROM friend_requests WHERE from_user=? AND to_user=? AND status='pending'",
        (from_u, to_u)).fetchone()
    if pending: return jsonify({'success':False,'error':'已发送过申请'})
    db.execute("INSERT INTO friend_requests (from_user,to_user,status,created_at) VALUES (?,?,?,?)",
        (from_u, to_u, 'pending', time.time()))
    db.commit()
    return jsonify({'success':True})

@app.route('/api/friends/requests/<uid>', methods=['GET'])
def get_friend_requests(uid):
    db = get_db()
    rows = db.execute(
        "SELECT fr.*, u.nickname as from_nickname FROM friend_requests fr LEFT JOIN users u ON fr.from_user=u.id WHERE fr.to_user=? AND fr.status='pending'",
        (uid,)).fetchall()
    return jsonify({'success':True,'requests':rows_to_list(rows)})

@app.route('/api/friends/respond', methods=['POST'])
def respond_friend_request():
    data = request.get_json()
    from_u = data['from']
    to_u = data['to']
    action = data['action']
    db = get_db()
    db.execute("UPDATE friend_requests SET status=? WHERE from_user=? AND to_user=? AND status='pending'",
        (action, from_u, to_u))
    if action == 'accepted':
        a, b = sorted([from_u, to_u])
        db.execute("INSERT OR IGNORE INTO friends (user_a,user_b) VALUES (?,?)", (a, b))
    db.commit()
    return jsonify({'success':True})

# ============================================================
# 交互 API
# ============================================================
@app.route('/api/action/click', methods=['POST'])
def click_avatar():
    data = request.get_json()
    op_id, target_id = data['operator'], data['target']
    db = get_db()
    op = row_to_dict(db.execute("SELECT * FROM users WHERE id=?",(op_id,)).fetchone())
    if op['anger'] >= 999:
        db.execute("UPDATE users SET anger=MAX(0,anger-1) WHERE id=?",(target_id,))
        effect = 'love'
    else:
        db.execute("UPDATE users SET anger=anger+1 WHERE id=?",(target_id,))
        effect = 'hit'
    db.execute("UPDATE users SET tolerance=tolerance+1 WHERE id=?",(op_id,))
    # 更新每日包容值
    today = datetime.now().strftime('%Y-%m-%d')
    op2 = row_to_dict(db.execute("SELECT * FROM users WHERE id=?",(op_id,)).fetchone())
    dt = json.loads(op2.get('dailyTolerance','{}'))
    dt[today] = max(dt.get(today,0), op2['tolerance'])
    db.execute("UPDATE users SET dailyTolerance=? WHERE id=?",(json.dumps(dt), op_id))
    db.commit()
    return jsonify({'success':True,'effect':effect,'operatorTolerance':op2['tolerance']})

@app.route('/api/action/longpress', methods=['POST'])
def longpress_avatar():
    data = request.get_json()
    op_id, target_id = data['operator'], data['target']
    db = get_db()
    db.execute("UPDATE users SET anger=MAX(0,anger-1) WHERE id=?",(target_id,))
    db.execute("UPDATE users SET tolerance=tolerance+1 WHERE id=?",(op_id,))
    today = datetime.now().strftime('%Y-%m-%d')
    op2 = row_to_dict(db.execute("SELECT * FROM users WHERE id=?",(op_id,)).fetchone())
    dt = json.loads(op2.get('dailyTolerance','{}'))
    dt[today] = max(dt.get(today,0), op2['tolerance'])
    db.execute("UPDATE users SET dailyTolerance=? WHERE id=?",(json.dumps(dt), op_id))
    db.commit()
    return jsonify({'success':True,'effect':'love','operatorTolerance':op2['tolerance']})

# ============================================================
# 聊天 API
# ============================================================
@app.route('/api/chat/<a>/<b>', methods=['GET'])
def get_chat(a, b):
    db = get_db()
    msgs = rows_to_list(db.execute(
        "SELECT * FROM messages WHERE (from_user=? AND to_user=?) OR (from_user=? AND to_user=?) ORDER BY timestamp",
        (a, b, b, a)).fetchall())
    return jsonify({'success':True,'messages':msgs})

@app.route('/api/chat/send', methods=['POST'])
def send_chat():
    data = request.get_json()
    db = get_db()
    db.execute("INSERT INTO messages (from_user,to_user,text,timestamp) VALUES (?,?,?,?)",
        (data['from'], data['to'], data['text'], time.time()))
    db.commit()
    return jsonify({'success':True})

# ============================================================
# 排行榜 API
# ============================================================
@app.route('/api/rankings', methods=['GET'])
def rankings():
    rtype = request.args.get('type','tolerance')
    column = 'anger' if rtype == 'anger' else 'tolerance'
    db = get_db()
    users = rows_to_list(db.execute(f"SELECT id,nickname,avatar,avatarFrame,anger,tolerance,title FROM users ORDER BY {column} DESC").fetchall())
    return jsonify({'success':True,'users':users})

@app.route('/api/recommend', methods=['GET'])
def recommend():
    week = get_week_range()
    db = get_db()
    users = rows_to_list(db.execute("SELECT * FROM users").fetchall())
    qualified = []
    for u in users:
        dt = json.loads(u.get('dailyTolerance','{}'))
        if all(dt.get(d,0) >= 999 for d in week):
            u['title'] = '最值得交往的朋友'
            qualified.append(u)
    qualified.sort(key=lambda x: x.get('tolerance',0), reverse=True)
    return jsonify({'success':True,'users':qualified,'week':{'start':week[0],'end':week[-1]}})

# ============================================================
# 商城 API
# ============================================================
SHOP_ITEMS = [
    {'id':'frame_calm','name':'心如止水','cost':200,'frameClass':'calm','emoji':'🪷','desc':'水流莲花·心澄如镜'},
    {'id':'frame_bamboo','name':'虚怀若竹','cost':280,'frameClass':'bamboo','emoji':'🎋','desc':'翠竹清风·谦谦君子'},
    {'id':'frame_capybara','name':'卡皮巴拉','cost':350,'frameClass':'capybara','emoji':'🦫','desc':'淡定水豚·情绪稳定'},
    {'id':'frame_cloud','name':'云淡风轻','cost':420,'frameClass':'cloud','emoji':'☁️','desc':'飘逸白云·宠辱不惊'},
    {'id':'frame_master','name':'包容大师','cost':500,'frameClass':'master','emoji':'🌊','desc':'海纳百川·有容乃大'},
    {'id':'frame_smile','name':'弥勒笑颜','cost':650,'frameClass':'smile','emoji':'😊','desc':'慈眉善目·笑口常开'},
    {'id':'frame_zen','name':'上善若水','cost':999,'frameClass':'zen','emoji':'💧','desc':'终极形态·水滴石穿'},
]

@app.route('/api/shop/items', methods=['GET'])
def shop_items():
    return jsonify({'success':True,'items':SHOP_ITEMS})

@app.route('/api/shop/purchase', methods=['POST'])
def shop_purchase():
    data = request.get_json()
    uid, item_id = data['userId'], data['itemId']
    item = next((i for i in SHOP_ITEMS if i['id']==item_id), None)
    if not item: return jsonify({'success':False,'error':'商品不存在'})
    db = get_db()
    user = row_to_dict(db.execute("SELECT * FROM users WHERE id=?",(uid,)).fetchone())
    if user['tolerance'] < item['cost']: return jsonify({'success':False,'error':'包容值不足'})
    if user['avatarFrame'] == item['frameClass']: return jsonify({'success':False,'error':'已拥有'})
    db.execute("UPDATE users SET tolerance=tolerance-?, avatarFrame=? WHERE id=?", (item['cost'], item['frameClass'], uid))
    db.commit()
    return jsonify({'success':True})

# ============================================================
# 后台管理 API
# ============================================================
@app.route('/api/admin/stats', methods=['GET'])
def admin_stats():
    db = get_db()
    total = db.execute("SELECT COUNT(*) as c FROM users").fetchone()['c']
    today = datetime.now().strftime('%Y-%m-%d')
    today_new = db.execute("SELECT COUNT(*) as c FROM users WHERE registerDate=?",(today,)).fetchone()['c']
    anger_over = db.execute("SELECT COUNT(*) as c FROM users WHERE anger>=999").fetchone()['c']
    tolerance_over = db.execute("SELECT COUNT(*) as c FROM users WHERE tolerance>=999").fetchone()['c']
    return jsonify({'success':True,'stats':{
        'totalUsers':total,'todayNew':today_new,
        'angerOver999':anger_over,'toleranceOver999':tolerance_over
    }})

@app.route('/api/admin/users', methods=['GET'])
def admin_users():
    db = get_db()
    search = request.args.get('q','')
    if search:
        users = rows_to_list(db.execute(
            "SELECT * FROM users WHERE phone LIKE ? OR nickname LIKE ? ORDER BY createdAt DESC",
            (f'%{search}%', f'%{search}%')).fetchall())
    else:
        users = rows_to_list(db.execute("SELECT * FROM users ORDER BY createdAt DESC").fetchall())
    # 手机号脱敏
    for u in users:
        p = u.get('phone','')
        if len(p)==11: u['phone_masked'] = p[:3]+'****'+p[-4:]
        else: u['phone_masked'] = p
    return jsonify({'success':True,'users':users})

# ============================================================
# 静态文件 & 首页
# ============================================================
@app.route('/')
def index():
    try:
        return send_from_directory(SRC_DIR, 'login.html')
    except:
        return jsonify({'success':True,'msg':'火气很大H5后端运行中','static_dir':SRC_DIR,'files':os.listdir(SRC_DIR)[:10] if os.path.exists(SRC_DIR) else 'DIR_NOT_FOUND'})

@app.route('/<path:path>')
def static_files(path):
    if path.startswith('api/'): return jsonify({'success':False,'error':'Unknown'}),404
    try:
        return send_from_directory(SRC_DIR, path)
    except:
        return jsonify({'error':'File not found','path':path,'static_dir':SRC_DIR}),404

# ============================================================
# 启动
# ============================================================
if __name__ == '__main__':
    import sys
    port = int(os.environ.get('PORT', 5050))
    print('='*50)
    print('  火气很大 H5 - 后端服务')
    print(f'  端口: {port}')
    print('='*50)
    app.run(host='0.0.0.0', port=port, debug=False)
