import 'dotenv/config';

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import timeout from 'connect-timeout';
import rateLimit from 'express-rate-limit';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import authRoutes from './routes/auth.js';
import cookieParser from 'cookie-parser';

const app = express();
const PORT = 3002;

// 파일 경로 설정
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const postsFilePath = path.join(__dirname, 'data', 'posts.json');
const usersFilePath = path.join(__dirname, 'data', 'users.json');

app.use(helmet({
    contentSecurityPolicy: false, // 개발 환경에서만 비활성화 가능
    crossOriginResourcePolicy: { policy: "cross-origin" } // CORS 문제 방지
}));

app.use(cors({
    origin: ['http://localhost:3001','http://localhost:3002'], 
    credentials: true,  
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
}));



app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(timeout('10s'));

app.use('/api/auth', authRoutes);


// JWT 인증 미들웨어
const isAuthenticated = (req, res, next) => {
    const token = req.cookies.token;  
    console.log(" 쿠키에서 토큰 확인:", token);
  
    if (!token) {
      return res.status(401).json({ success: false, message: '인증이 필요합니다.' });
    }
  
    try {
      const decoded = jwt.verify(token, process.env.SECRET_KEY);  // 토큰 검증
      req.user = decoded;  // 사용자 정보 저장
      console.log(" 토큰 검증 성공:", decoded);
      next();
    } catch (error) {
      console.error(" 토큰 검증 실패:", error.message);
      return res.status(401).json({ success: false, message: '유효하지 않은 토큰입니다.' });
    }
};

// 초기 데이터 보장
const ensurePostsFile = async () => {
    try {
        const dirPath = path.dirname(postsFilePath);
        await fs.mkdir(dirPath, { recursive: true });
        try {
            await fs.access(postsFilePath);
        } catch {
            await fs.writeFile(postsFilePath, JSON.stringify([], null, 2)); //  초기화
        }
    } catch (error) {
        console.error('Error initializing posts file:', error.message);
    }
};

// 데이터 로드 및 저장
const loadPosts = async () => {
    try {
        const data = await fs.readFile(postsFilePath, 'utf8');
        // 디버깅 로그
        console.log('Loaded Posts Data:', data);
        return JSON.parse(data);
    } catch (error) {
        console.error('Error loading posts:', error.message);
        return [];
    }
};


// API 엔드포인트
app.get('/api/session/user', (req, res) => {
    const token = req.cookies.token;
    console.log(" 쿠키에서 토큰 확인:", token);

    if (!token) {
        return res.status(401).json({ success: false, message: '로그인이 필요합니다.' });
    }

    try {
        const decoded = jwt.verify(token, process.env.SECRET_KEY);
        console.log(" 사용자 인증 성공:", decoded);
        res.json({ success: true, user: decoded });
    } catch (error) {
        console.error(" JWT 검증 실패:", error.message);
        res.status(401).json({ success: false, message: '유효하지 않은 토큰입니다.' });
    }
});

const savePosts = async posts => {
    try {
        await fs.writeFile(postsFilePath, JSON.stringify(posts, null, 2));
    } catch (error) {
        console.error('Error saving posts:', error.message);
    }
};

// 공통 함수: 게시글 및 댓글 찾기
const findPostById = async id => {
    const posts = await loadPosts();
    const postIndex = posts.findIndex(post => post.id === id);

    console.log('Requested ID:', id);
    console.log('Available Posts:', posts);
    console.log('Found Post:', posts[postIndex]);

    if (postIndex === -1) return { post: null, posts, postIndex: -1 };
    return { post: posts[postIndex] || null, posts, postIndex };
};

const findCommentById = (post, commentId) => {
    const commentIndex = post.comments.findIndex(
        comment => comment.id === commentId,
    );
    return { comment: post.comments[commentIndex] || null, commentIndex };
};

const postLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15분
    max: 10, // 글 작성, 좋아요 최대 10번만 가능
    message: { success: false, message: "요청이 너무 많습니다. 나중에 다시 시도하세요." },
});

const getRateLimiter = rateLimit({
    windowMs: 10 * 1000, // 10초
    max: 10, // 10초 동안 최대 10번 요청 가능
    message: { success: false, message: "요청이 너무 많습니다. 잠시 후 다시 시도해주세요." },
});

app.get('/api/posts', getRateLimiter, async (req, res) => {
  const s = Number(req.query.start ?? 0) || 0;
  const l = Number(req.query.limit ?? 10) || 10;

  const posts = await loadPosts();
  const sortedPosts = posts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const page = sortedPosts.slice(s, s + l);

  res.json({ data: page, hasMore: s + l < posts.length });
});

// 글 작성 요청에만 레이트 리미트 적용 (게시글 작성 제한: 10분에 5개)
const modifyRateLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 5,
    message: "게시글 작성이 너무 많습니다. 10분 후 다시 시도하세요."
});

app.post('/api/posts', isAuthenticated, modifyRateLimiter, async (req, res) => {
    const { title, content } = req.body;
    const author = req.user.nickname;

    if (!title || !content) {
        return res.status(400).json({ success: false, message: "제목과 내용을 입력하세요." });
    }

    const newPost = {
        id: uuidv4(),
        title,
        content,
        author: req.user.nickname,
        authorId: req.user.id,
        createdAt: new Date().toISOString(),
        likes: 0,
        comments: [],
        views: 0,
        usersLikes: []
    };

    const posts = await loadPosts();
    posts.push(newPost);
    await savePosts(posts);

    res.status(201).json({ success: true, data: newPost });
});

app.put('/api/posts/:id', isAuthenticated, async (req, res) => {
    const { id } = req.params;
    const { title, content } = req.body;

    if (!title && !content) {
        return res.status(400).json({ success: false, message: '제목 또는 내용을 입력하세요.' });
    }

    const { post, posts, postIndex } = await findPostById(id);

    if (!post) {
        return res.status(404).json({ success: false, message: '게시글을 찾을 수 없습니다.' });
    }

    if (post.authorId !== req.user.id) {
        return res.status(403).json({ success: false, message: '게시글 수정 권한이 없습니다.' });
    }

    Object.assign(post, {
        title: title || post.title,
        content: content || post.content,
    });

    posts[postIndex] = post;
    await savePosts(posts);

    res.json({ success: true, data: post });
});

// 조회수 요청 제한
const viewRateLimitMap = new Map();

app.patch('/api/posts/:id/views', async (req, res) => {
    const { id } = req.params;
    const userAgent = req.headers['user-agent'];
    const userIP = req.ip;
    const userKey = `${userIP}-${userAgent || 'unknown'}`;
    const now = Date.now();
    const LIMIT_DURATION = 1 * 60 * 1000;

    const { post, posts, postIndex } = await findPostById(id);
    if (!post) {
        return res.status(404).json({ success: false, message: '게시글을 찾을 수 없습니다.' });
    }

    if (!viewRateLimitMap.has(userKey)) {
        viewRateLimitMap.set(userKey, new Map());
    }

    const userViews = viewRateLimitMap.get(userKey);
    const lastViewTime = userViews.get(id);

    if (lastViewTime && now - lastViewTime < LIMIT_DURATION) {
        return res.status(200).json({ success: false, message: '조회수는 일정 시간 후 다시 증가할 수 있습니다.' });
    }

    try {
        post.views = (post.views || 0) + 1;
        posts[postIndex] = post;
        await savePosts(posts);

        userViews.set(id, now);
        res.json({ success: true, data: post });
    } catch (error) {
        console.error('Error updating view count:', error);
        res.status(500).json({ success: false, message: '조회수를 업데이트할 수 없습니다.' });
    }
});

app.delete('/api/posts/:id',isAuthenticated, async (req, res) => {
    const { post, posts, postIndex } = await findPostById(req.params.id);
    if (!post) {
        return res.status(404).json({ success: false, message: '게시글을 찾을 수 없습니다.' });
    }

        if (post.authorId !== req.user.id) {
        return res.status(403).json({
            success: false,
            message: '삭제 권한이 없습니다.'
        });
    }

    posts.splice(postIndex, 1);
    await savePosts(posts);

    res.status(200).json({
        success: true,
        message: '게시글이 삭제되었습니다.',
    });
});

// 좋아요 기능 (JWT 쿠키 기반 인증)
const likeRateLimit = rateLimit({
    windowMs: 1000,  // 1초
    max: 1,          // 1초에 1번 요청만 허용
    message: { success: false, message: "좋아요 요청이 너무 빠릅니다. 잠시 후 다시 시도하세요." }
});
app.patch('/api/posts/:id/likes', isAuthenticated, likeRateLimit, async (req, res) => {
    const { id } = req.params;
    const user = req.user.nickname;

    console.log('사용자 쿠키:', req.cookies.token);
    console.log('사용자 닉네임:', req.user.nickname);

    if (!user) {
        return res.status(400).json({ success: false, message: '로그인이 필요합니다.' });
    }

    const { post, posts, postIndex } = await findPostById(id);
    if (!post) {
        return res.status(404).json({ success: false, message: '게시글을 찾을 수 없습니다.' });
    }

    post.usersLikes = post.usersLikes || [];
    let isLiked;
    
    if (post.usersLikes.includes(user)) {
        post.likes = Math.max(0, post.likes - 1);
        post.usersLikes = post.usersLikes.filter(nickname => nickname !== user);
        isLiked = false;
    } else {
        post.likes += 1;
        post.usersLikes.push(user);
        isLiked = true;
    }
    
    console.log('현재 좋아요 수:', post.likes);  //  여기서 likes 값 확인
    
    posts[postIndex] = post;
    await savePosts(posts);
    
    res.json({
        success: true,
        likes: post.likes,   // 🔥 이 값이 최신 값인지 꼭 확인
        isLiked: isLiked,
        message: isLiked ? '좋아요 추가' : '좋아요 취소'
    });
    
    
});


// 댓글 기능
app.post('/api/posts/:id/comments', isAuthenticated, async (req, res) => {
    const { id } = req.params;
    const { content } = req.body;

    if (!content) {
        return res.status(400).json({ success: false, message: '댓글 내용을 입력해주세요.' });
    }

    const author = req.user.nickname;
    const { post, posts, postIndex } = await findPostById(id);

    if (!post) {
        return res.status(404).json({ success: false, message: '게시글을 찾을 수 없습니다.' });
    }

    const newComment = {
        id: uuidv4(),
        content,
        author: req.user.nickname,
        authorId: req.user.id,
        createdAt: new Date().toISOString(),
    };

    post.comments.push(newComment);
    post.commentsCount = (post.commentsCount || 0) + 1;

    try {
        await savePosts(posts);
        res.json({ success: true, comments: post.comments });
    } catch (error) {
        res.status(500).json({ success: false, message: '댓글 저장에 실패했습니다.' });
    }
});

app.get('/api/posts/:id/comments', async (req, res) => {
    const { post } = await findPostById(req.params.id);
    if (!post) {
        return res.status(404).json({ success: false, message: '게시글을 찾을 수 없습니다.' });
    }
    res.json({ success: true, data: post.comments });
});

// 댓글 수정
app.put('/api/posts/:id/comments/:commentId', isAuthenticated, async (req, res) => {
    const { id, commentId } = req.params;
    const { content } = req.body;

    if (!content) {
        return res.status(400).json({ success: false, message: '댓글 내용을 입력해주세요.' });
    }

    const { post, posts, postIndex } = await findPostById(id);

    if (!post) {
        return res.status(404).json({ success: false, message: '게시글을 찾을 수 없습니다.' });
    }

    const { comment } = findCommentById(post, commentId);

    if (!comment) {
        return res.status(404).json({ success: false, message: '댓글을 찾을 수 없습니다.' });
    }

    if (comment.authorId !== req.user.id) {
        return res.status(403).json({ success: false, message: '댓글 수정 권한이 없습니다.' });
    }

    comment.content = content;
    comment.updatedAt = new Date().toISOString();

    posts[postIndex] = post;
    await savePosts(posts);

    res.json({ success: true, data: comment });
});

// 댓글 삭제
app.delete('/api/posts/:id/comments/:commentId',  isAuthenticated, async (req, res) => {
    const { id, commentId } = req.params;
    const { post, posts, postIndex } = await findPostById(id);
    if (!post) {
        return res.status(404).json({ success: false, message: '게시글을 찾을 수 없습니다.' });
    }

   const { comment, commentIndex } = findCommentById(post, commentId);
    if (commentIndex === -1) {
        return res.status(404).json({ success: false, message: '댓글을 찾을 수 없습니다.' });
    }

     if (comment.authorId !== req.user.id) {
        return res.status(403).json({
            success: false,
            message: '댓글 삭제 권한이 없습니다.'
        });
    }

    post.comments.splice(commentIndex, 1);
    post.commentsCount -= 1;
    posts[postIndex] = post;
    await savePosts(posts);
    res.json({ success: true, message: '댓글이 삭제되었습니다.' });
});

app.get('/api/posts/:id', async (req, res) => {
    const { id } = req.params;
    const { post } = await findPostById(id);

    if (!post) {
        return res.status(404).json({ success: false, message: '게시글을 찾을 수 없습니다.' });
    }
    res.json({ success: true, data: post });
});

app.listen(PORT, async () => {
    await ensurePostsFile();
    console.log(`서버가 http://localhost:${PORT}에서 실행 중입니다.`);
});
