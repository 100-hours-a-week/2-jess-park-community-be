// routes/auth.js
import 'dotenv/config';

import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { fileURLToPath } from 'url';
import rateLimit from 'express-rate-limit';

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const usersFilePath = path.join(__dirname, '../data/users.json');

if (!process.env.SECRET_KEY) {
  throw new Error('SECRET_KEY is missing. Check your .env');
}

// 업로드 (프로필 이미지 등)
const upload = multer({ dest: 'uploads/' });

// ★ 개발환경 쿠키 옵션(서버/프론트가 http://localhost인 상황)
//   - sameSite:'lax'  (포트 달라도 same-site라 OK)
//   - secure:false    (HTTPS 아니므로 false)
//   - path:'/'        (모든 경로에서 전송)
const COOKIE_OPTS_BASE = { httpOnly: true, sameSite: 'lax', secure: false, path: '/' };
const COOKIE_MAX_AGE = 60 * 60 * 1000; // 1시간

// ──────────────────────────────────────────────────────────────
// 유틸: users.json 로드/저장
function ensureUsersFile() {
  try {
    if (!fs.existsSync(usersFilePath)) {
      fs.mkdirSync(path.dirname(usersFilePath), { recursive: true });
      fs.writeFileSync(usersFilePath, JSON.stringify([], null, 2));
    }
  } catch (e) {
    console.error('users.json 초기화 실패:', e.message);
  }
}
ensureUsersFile();

function loadUsers() {
  try {
    const data = fs.readFileSync(usersFilePath, 'utf8');
    return JSON.parse(data || '[]');
  } catch (e) {
    console.error('users.json 로드 실패:', e.message);
    return [];
  }
}

function saveUsers(users) {
  fs.writeFileSync(usersFilePath, JSON.stringify(users, null, 2));
}

// ──────────────────────────────────────────────────────────────
// JWT 인증 미들웨어
const verifyToken = (req, _res, next) => {
  console.log('[디버깅] 쿠키 내용:', req.cookies);
  const token = req.cookies?.token;

  if (!token) {
    return _res.status(401).json({ success: false, message: '인증이 필요합니다.' });
  }

  try {
    const decoded = jwt.verify(token, process.env.SECRET_KEY);
    req.user = decoded;
    console.log('[성공] JWT 검증 완료:', decoded);
    next();
  } catch (error) {
    console.log('[오류] JWT 검증 실패:', error.message);
    return _res.status(401).json({ success: false, message: '유효하지 않은 토큰입니다.' });
  }
};

// 로그인 시도 제한
const loginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5분
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: '로그인 시도가 너무 많습니다. 5분 후 다시 시도하세요.' },
});

// ──────────────────────────────────────────────────────────────
// 로그인 상태 확인
router.get('/check', verifyToken, (req, res) => {
  res.json({ success: true, user: req.user });
});

// 회원가입
router.post('/signup', upload.single('profile'), async (req, res) => {
  const { email, password, nickname } = req.body;
  if (!email || !password || !nickname) {
    return res.status(400).json({ success: false, message: '모든 필드를 입력해야 합니다.' });
  }

  const users = loadUsers();

  if (users.some((u) => u.email === email)) {
    return res.status(400).json({ success: false, message: '이미 존재하는 이메일입니다.' });
  }
  if (users.some((u) => u.nickname === nickname)) {
    return res.status(400).json({ success: false, message: '이미 사용 중인 닉네임입니다.' });
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  users.push({
    id: Date.now(),
    email,
    password: hashedPassword,
    nickname,
    profile: req.file ? req.file.path : null,
  });

  saveUsers(users);
  res.json({ success: true, message: '회원가입 성공' });
});

// 로그인
router.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ success: false, message: '이메일과 비밀번호를 입력해주세요.' });
  }

  const users = loadUsers();
  const user = users.find((u) => u.email === email);
  if (!user) {
    return res.status(404).json({ success: false, message: '사용자를 찾을 수 없습니다.' });
  }

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) {
    return res.status(401).json({ success: false, message: '비밀번호가 틀렸습니다.' });
  }

const token = jwt.sign(
  {
    id: user.id,
    email: user.email,
    nickname: user.nickname
  },
  process.env.SECRET_KEY,
  { expiresIn: '1h' }
);

  res.cookie('token', token, { ...COOKIE_OPTS_BASE, maxAge: COOKIE_MAX_AGE });
  res.json({ success: true, message: '로그인 성공', user: { email: user.email, nickname: user.nickname } });
});

// 로그아웃 (★ 지울 때도 같은 옵션으로)
router.post('/logout', (req, res) => {
  res.clearCookie('token', COOKIE_OPTS_BASE);
  res.json({ success: true, message: '로그아웃 성공' });
});

// 프로필 수정
router.put('/user/profile', upload.single('profile'), verifyToken, (req, res) => {
  const { nickname } = req.body;
  const users = loadUsers();
  const user = users.find((u) => u.email === req.user.email);

  if (!user) {
    return res.status(404).json({ success: false, message: '사용자를 찾을 수 없습니다.' });
  }

  if (nickname) user.nickname = nickname;
  if (req.file) user.profile = req.file.path;

  saveUsers(users);
  res.json({ success: true, message: '회원정보 수정 성공', user: { email: user.email, nickname: user.nickname, profile: user.profile ?? null } });
});

// 비밀번호 변경
router.put('/user/password', verifyToken, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ success: false, message: '필수 정보가 누락되었습니다.' });
  }

  const users = loadUsers();
  const user = users.find((u) => u.email === req.user.email);
  if (!user) {
    return res.status(404).json({ success: false, message: '사용자를 찾을 수 없습니다.' });
  }

  const isMatch = await bcrypt.compare(currentPassword, user.password);
  if (!isMatch) {
    return res.status(401).json({ success: false, message: '현재 비밀번호가 올바르지 않습니다.' });
  }

  user.password = await bcrypt.hash(newPassword, 10);
  saveUsers(users);
  res.json({ success: true, message: '비밀번호 변경 성공' });
});

export default router;
