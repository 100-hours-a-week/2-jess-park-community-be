import express from 'express';
import session from 'express-session'; 
import helmet from 'helmet';
import cors from 'cors';
import timeout from 'connect-timeout';
import rateLimit from 'express-rate-limit';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';

const app = express();
const PORT = 3002;


// 파일 경로 설정
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const postsFilePath = path.join(__dirname, 'data', 'posts.json');
const usersFilePath = path.join(__dirname, 'data', 'users.json');

// 보안 및 미들웨어 설정
app.use(helmet());
app.use(cors({ origin: ['http://localhost:3001', 'http://127.0.0.1:5500'], credentials: true }));
app.use(timeout('10s'));
app.use(express.static(path.join(__dirname, 'public')));


// JWT 인증 미들웨어
const isAuthenticated = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
        return res.status(401).json({ success: false, message: '인증이 필요합니다.' });
    }

    const token = authHeader.split(' ')[1]; // "Bearer TOKEN" 형식이므로 분리
    if (!token) {
        return res.status(401).json({ success: false, message: '유효하지 않은 토큰입니다.' });
    }

    try {
        const decoded = jwt.verify(token, SECRET_KEY);
        req.user = decoded; // 사용자 정보 저장
        next();
    } catch (error) {
        return res.status(401).json({ success: false, message: '토큰 검증 실패' });
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
            await fs.writeFile(postsFilePath, JSON.stringify([], null, 2)); // ✅ 초기화
        }
    } catch (error) {
        console.error('Error initializing posts file:', error.message);
    }
};


// 데이터 로드 및 저장
const loadPosts = async () => {
    try {
        const data = await fs.readFile(postsFilePath, 'utf8');

        // 디버깅 로그 추가
        console.log('Loaded Posts Data:', data);

        return JSON.parse(data);
    } catch (error) {
        console.error('Error loading posts:', error.message);
        return [];
    }
};



app.post('/api/login', (req, res) => {
    const { username } = req.body;
    console.log("🔵 [서버] 로그인 시도:", username);

    req.session.user = { nickname: username };
    console.log("✅ [서버] 로그인 성공, 세션 저장됨:", req.session.user);
    
    res.json({ success: true, user: req.session.user });
});

app.get('/api/session/user', (req, res) => {
    console.log("🔴 [서버] 세션 체크 요청 들어옴");
    console.log("🟡 [서버] 현재 세션 정보:", req.session);

    if (!req.session.user) {
        console.log("❌ [서버] 세션 없음, 로그인 필요");
        return res.status(401).json({ success: false, message: '로그인이 필요합니다.' });
    }

    console.log("✅ [서버] 세션 유지 중:", req.session.user);
    res.json({ success: true, user: req.session.user });
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

    // 디버깅 로그 추가
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

// API 엔드포인트
app.get('/api/session/user', (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({ success: false, message: '로그인이 필요합니다.' });
    }
    res.json({ success: true, user: req.session.user });
});


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
    const { start = 0, limit = 10 } = req.query;

    const posts = await loadPosts();
    const sortedPosts = posts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const paginatedPosts = sortedPosts.slice(start, start + limit);

    res.json({ data: paginatedPosts, hasMore: start + limit < posts.length });
});


// 글 작성 요청에만 레이트 리미트 적용
// 게시글 작성 제한 (10분에 5개)
const modifyRateLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 5,
    message: "게시글 작성이 너무 많습니다. 10분 후 다시 시도하세요."
});

app.post('/api/posts', isAuthenticated, modifyRateLimiter, async (req, res) => {
    const { title, content } = req.body;
    const author = req.user.nickname; // JWT에서 사용자 정보 가져오기

    if (!title || !content) {
        return res.status(400).json({ success: false, message: "제목과 내용을 입력하세요." });
    }

    const newPost = {
        id: uuidv4(),
        title,
        content,
        author,
        createdAt: new Date().toISOString(),
        likes: 0,
        comments: [],
        views: 0,
    };

    const posts = await loadPosts();
    posts.push(newPost);
    await savePosts(posts);

    res.status(201).json({ success: true, data: newPost });
});

app.put('/api/posts/:id', async (req, res) => {
    const { id } = req.params;
    const { title, content, author } = req.body;
    if (!title && !content) {
        return res
            .status(400)
            .json({ success: false, message: '제목 또는 내용을 입력하세요.' });
    }

    const { post, posts, postIndex } = await findPostById(id);
    if (!post) {
        return res
            .status(404)
            .json({ success: false, message: '게시글을 찾을 수 없습니다.' });
    }

    Object.assign(post, {
        title: title || post.title,
        content: content || post.content,
        author: author || post.author,
    });
    posts[postIndex] = post;
    await savePosts(posts);

    res.json({ success: true, data: post });
});






// 조회수 요청 제한을 위한 데이터 저장소
const viewRateLimitMap = new Map();

app.patch('/api/posts/:id/views', async (req, res) => {
    const { id } = req.params;
    const userAgent = req.headers['user-agent'];
    const userIP = req.ip; // 사용자 IP 가져오기
    const userKey = `${userIP}-${userAgent || 'unknown'}`; // IP + User-Agent 조합으로 키 생성
    const now = Date.now();
    const LIMIT_DURATION = 1 * 60 * 1000; // 1분 동안 중복 조회 방지 (기존 5분 → 1분으로 변경)

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
        // 조회수 증가
        post.views = (post.views || 0) + 1;
        posts[postIndex] = post;
        await savePosts(posts);

        // 사용자 조회 기록 갱신
        userViews.set(id, now);
        res.json({ success: true, data: post });
    } catch (error) {
        console.error('Error updating view count:', error);
        res.status(500).json({ success: false, message: '조회수를 업데이트할 수 없습니다.' });
    }
});


app.delete('/api/posts/:id', async (req, res) => {
    const { post, posts, postIndex } = await findPostById(req.params.id);
    if (!post) {
        return res
            .status(404)
            .json({ success: false, message: '게시글을 찾을 수 없습니다.' });
    }

    posts.splice(postIndex, 1);
    await savePosts(posts);
    res.status(200).json({
        success: true,
        message: '게시글이 삭제되었습니다.',
    });
});

const likesRateLimitMap = new Map();

// 좋아요 기능 (계정당 한 번만)
app.patch('/api/posts/:id/likes', async (req, res) => {
    const { post, posts, postIndex } = await findPostById(req.params.id);
    const user = req.body.author; // 클라이언트로부터 받은 사용자 닉네임
    const now = Date.now();
    const LIMIT_DURATION = 1 * 60 * 1000; // 1분 타임아웃

    if (!user) {
        return res
            .status(400)
            .json({ success: false, message: '로그인이 필요합니다.' });
    }

    // 사용자 요청 기록 확인
    if (!likesRateLimitMap.has(user)) {
        likesRateLimitMap.set(user, 0); // 초기화
    }

    const lastRequestTime = likesRateLimitMap.get(user);

    if (now - lastRequestTime < LIMIT_DURATION) {
        return res.status(429).json({
            success: false,
            message: `좋아요는 ${LIMIT_DURATION / 1000}초에 한 번만 가능합니다.`,
        });
    }

    if (!post) {
        return res
            .status(404)
            .json({ success: false, message: '게시글을 찾을 수 없습니다.' });
    }

    if (post.usersLikes.includes(user)) {
        // 이미 좋아요를 누른 경우 좋아요 취소
        post.likes -= 1;
        post.usersLikes = post.usersLikes.filter(nickname => nickname !== user);
    } else {
        // 좋아요 추가
        post.likes += 1;
        post.usersLikes.push(user);
    }

    // 좋아요 상태 저장
    likesRateLimitMap.set(user, now);
    posts[postIndex] = post;
    await savePosts(posts);

    res.json({ success: true, likes: post.likes });
});

// 댓글 기능
app.post('/api/posts/:id/comments', async (req, res) => {
    console.log('Received Comment Request:', req.body); // 요청 본문 확인

    const { id } = req.params;
    const { content, author } = req.body;

    if (!content || !author) {
        console.error('Invalid Comment Data:', req.body);
        return res.status(400).json({
            success: false,
            message: '댓글 내용과 작성자를 입력해주세요.',
        });
    }

    const { post, posts, postIndex } = await findPostById(id);

    if (!post) {
        console.error('Post Not Found:', id);
        return res
            .status(404)
            .json({ success: false, message: '게시글을 찾을 수 없습니다.' });
    }

    const newComment = {
        id: uuidv4(),
        content,
        author,
        createdAt: new Date().toISOString(),
    };

    post.comments.push(newComment);
    post.commentsCount += 1;
    posts[postIndex] = post;

    try {
        await savePosts(posts);
        console.log('Comment Added Successfully:', newComment);
        res.json({ success: true, comments: post.comments });
    } catch (error) {
        console.error('Error Saving Comments:', error);
        res.status(500).json({
            success: false,
            message: '댓글 저장에 실패했습니다.',
        });
    }
});

app.get('/api/posts/:id/comments', async (req, res) => {
    const { post } = await findPostById(req.params.id);
    if (!post) {
        return res
            .status(404)
            .json({ success: false, message: '게시글을 찾을 수 없습니다.' });
    }
    res.json({ success: true, data: post.comments });
});

// 댓글 수정
app.put('/api/posts/:id/comments/:commentId', async (req, res) => {
    const { id, commentId } = req.params;
    const { content } = req.body;

    if (!content) {
        return res
            .status(400)
            .json({ success: false, message: '댓글 내용을 입력해주세요.' });
    }

    const { post, posts, postIndex } = await findPostById(id);
    if (!post) {
        return res
            .status(404)
            .json({ success: false, message: '게시글을 찾을 수 없습니다.' });
    }

    const { comment } = findCommentById(post, commentId);
    if (!comment) {
        return res
            .status(404)
            .json({ success: false, message: '댓글을 찾을 수 없습니다.' });
    }

    comment.content = content;
    comment.updatedAt = new Date().toISOString();
    posts[postIndex] = post;
    await savePosts(posts);
    res.json({ success: true, data: comment });
});

// 댓글 삭제
app.delete('/api/posts/:id/comments/:commentId', async (req, res) => {
    const { id, commentId } = req.params;
    const { post, posts, postIndex } = await findPostById(id);
    if (!post) {
        return res
            .status(404)
            .json({ success: false, message: '게시글을 찾을 수 없습니다.' });
    }

    const { commentIndex } = findCommentById(post, commentId);
    if (commentIndex === -1) {
        return res
            .status(404)
            .json({ success: false, message: '댓글을 찾을 수 없습니다.' });
    }

    post.comments.splice(commentIndex, 1);
    post.commentsCount -= 1; // 댓글 수 감소
    posts[postIndex] = post;
    await savePosts(posts);
    res.json({ success: true, message: '댓글이 삭제되었습니다.' });
});


// 서버 시작
app.listen(PORT, async () => {
    await ensurePostsFile();
    console.log(`서버가 http://localhost:${PORT}에서 실행 중입니다.`);
});
