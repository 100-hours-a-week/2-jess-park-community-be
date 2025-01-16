import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

const app = express();
const PORT = 3002;

// 파일 경로 설정
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const postsFilePath = path.join(__dirname, 'data', 'posts.json');

// CORS 설정
const allowedOrigins = ['http://localhost:3001', 'http://127.0.0.1:5500'];
app.use(cors({ origin: allowedOrigins, credentials: true }));


// Express 미들웨어
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 초기 데이터 보장
const ensurePostsFile = async () => {
  try {
    const dirPath = path.dirname(postsFilePath);
    await fs.mkdir(dirPath, { recursive: true });
    try {
      await fs.access(postsFilePath);
    } catch {
      const defaultPosts = [
        {
          id: 'board',
          title: '게시글 제목',
          content: '게시글 내용입니다.',
          author: '관리자',
          createdAt: new Date().toISOString(),
          likes: 0,
          comments: [],
          usersLikes: [], // 좋아요 누른 사용자 기록 추가
          commentsCount: 0, // 댓글 수 추가
        },
      ];
      await fs.writeFile(postsFilePath, JSON.stringify(defaultPosts, null, 2));
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


const savePosts = async (posts) => {
  try {
    await fs.writeFile(postsFilePath, JSON.stringify(posts, null, 2));
  } catch (error) {
    console.error('Error saving posts:', error.message);
  }
};

// 공통 함수: 게시글 및 댓글 찾기
const findPostById = async (id) => {
  const posts = await loadPosts();
  const postIndex = posts.findIndex((post) => post.id === id);

  // 디버깅 로그 추가
  console.log('Requested ID:', id);
  console.log('Available Posts:', posts);
  console.log('Found Post:', posts[postIndex]);

  return { post: posts[postIndex] || null, posts, postIndex };
};


const findCommentById = (post, commentId) => {
  const commentIndex = post.comments.findIndex((comment) => comment.id === commentId);
  return { comment: post.comments[commentIndex] || null, commentIndex };
};

// API 엔드포인트
app.get('/api/posts', async (req, res) => {
  const { start = 0, limit = 10 } = req.query;
  const posts = await loadPosts();
  const startIndex = Math.max(0, parseInt(start, 10));
  const limitCount = Math.min(100, Math.max(1, parseInt(limit, 10)));
  res.json({
    success: true,
    data: posts.slice(startIndex, startIndex + limitCount),
    hasMore: startIndex + limitCount < posts.length,
  });
});

app.post('/api/posts', async (req, res) => {
  const { title, content, author } = req.body;
  if (!title || !content || !author) {
      return res.status(400).json({ success: false, message: '제목, 내용, 작성자를 입력해주세요.' });
  }

  // 게시글 생성 시 필요한 newPost 정의
  const newPost = { 
      id: uuidv4(), 
      title, 
      content, 
      author, 
      createdAt: new Date().toISOString(), 
      likes: 0, 
      comments: [], 
      usersLikes: [], 
      commentsCount: 0,
      views: 0 // 조회수 초기화
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
    return res.status(400).json({ success: false, message: '제목 또는 내용을 입력하세요.' });
  }

  const { post, posts, postIndex } = await findPostById(id);
  if (!post) {
    return res.status(404).json({ success: false, message: '게시글을 찾을 수 없습니다.' });
  }

  Object.assign(post, { title: title || post.title, content: content || post.content, author: author || post.author });
  posts[postIndex] = post;
  await savePosts(posts);

  res.json({ success: true, data: post });
});

app.get('/api/posts/:id', async (req, res) => {
  const { post } = await findPostById(req.params.id);

  if (!post) {
      return res.status(404).json({ success: false, message: '게시글을 찾을 수 없습니다.' });
  }

  res.json({ success: true, data: post });
});

// 조회수 요청 제한을 위한 데이터 저장소
const viewRateLimitMap = new Map();

app.patch('/api/posts/:id/views', async (req, res) => {
    const { id } = req.params;
    const userAgent = req.headers['user-agent']; // 클라이언트 정보를 식별하기 위한 User-Agent
    const userKey = userAgent || 'unknown'; // User-Agent 기반 제한, 필요 시 사용자 ID로 대체 가능
    const now = Date.now();
    const LIMIT_DURATION = 5 * 60 * 1000; // 5분 동안 중복 조회수 제한

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
        return res.status(429).json({ success: false, message: '조회수는 일정 시간 내 중복 증가할 수 없습니다.' });
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
    return res.status(404).json({ success: false, message: '게시글을 찾을 수 없습니다.' });
  }

  posts.splice(postIndex, 1);
  await savePosts(posts);
  res.status(200).json({ success: true, message: '게시글이 삭제되었습니다.' });
});


const likesRateLimitMap = new Map();

// 좋아요 기능 (계정당 한 번만)
app.patch('/api/posts/:id/likes', async (req, res) => {
  const { post, posts, postIndex } = await findPostById(req.params.id);
  const user = req.body.author; // 클라이언트로부터 받은 사용자 닉네임
  const now = Date.now();
  const LIMIT_DURATION = 1 * 60 * 1000; // 1분 타임아웃

  if (!user) {
      return res.status(400).json({ success: false, message: '로그인이 필요합니다.' });
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
      return res.status(404).json({ success: false, message: '게시글을 찾을 수 없습니다.' });
  }

  if (post.usersLikes.includes(user)) {
      // 이미 좋아요를 누른 경우 좋아요 취소
      post.likes -= 1;
      post.usersLikes = post.usersLikes.filter((nickname) => nickname !== user);
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
    return res.status(400).json({ success: false, message: '댓글 내용과 작성자를 입력해주세요.' });
  }

  const { post, posts, postIndex } = await findPostById(id);

  if (!post) {
    console.error('Post Not Found:', id);
    return res.status(404).json({ success: false, message: '게시글을 찾을 수 없습니다.' });
  }

  const newComment = { id: uuidv4(), content, author, createdAt: new Date().toISOString() };

  post.comments.push(newComment);
  post.commentsCount += 1;
  posts[postIndex] = post;

  try {
    await savePosts(posts);
    console.log('Comment Added Successfully:', newComment);
    res.json({ success: true, comments: post.comments });
  } catch (error) {
    console.error('Error Saving Comments:', error);
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
app.put('/api/posts/:id/comments/:commentId', async (req, res) => {
  const { id, commentId } = req.params;
  const { content } = req.body;

  if (!content) {
    return res.status(400).json({ success: false, message: '댓글 내용을 입력해주세요.' });
  }

  const { post, posts, postIndex } = await findPostById(id);
  if (!post) {
    return res.status(404).json({ success: false, message: '게시글을 찾을 수 없습니다.' });
  }

  const { comment, commentIndex } = findCommentById(post, commentId);
  if (!comment) {
    return res.status(404).json({ success: false, message: '댓글을 찾을 수 없습니다.' });
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
    return res.status(404).json({ success: false, message: '게시글을 찾을 수 없습니다.' });
  }

  const { commentIndex } = findCommentById(post, commentId);
  if (commentIndex === -1) {
    return res.status(404).json({ success: false, message: '댓글을 찾을 수 없습니다.' });
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
