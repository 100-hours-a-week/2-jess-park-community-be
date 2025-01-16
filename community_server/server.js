import express from 'express';
import cors from 'cors';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

// 환경변수 설정
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3002;

// CORS 설정
app.use(cors({ 
    origin: ['http://localhost:3001', 'http://127.0.0.1:5500'],
    credentials: true 
}));
app.use(express.json());

// MariaDB 연결 설정 - 환경변수 사용
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

// 게시글 테이블 생성 쿼리
const createTableQuery = `
    CREATE TABLE IF NOT EXISTS posts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        content TEXT NOT NULL,
        author VARCHAR(100) NOT NULL,
        userId VARCHAR(50),
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
`;

// 테이블 생성
pool.query(createTableQuery)
    .then(() => console.log('posts 테이블 준비 완료'))
    .catch(err => console.error('테이블 생성 오류:', err));

// 댓글 테이블 생성 쿼리
const createCommentsTableQuery = `
    CREATE TABLE IF NOT EXISTS comments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        post_id INT NOT NULL,
        content TEXT NOT NULL,
        author VARCHAR(100) NOT NULL,
        userId VARCHAR(50),
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
    )
`;

// 댓글 테이블 생성
pool.query(createCommentsTableQuery)
    .then(() => console.log('comments 테이블 준비 완료'))
    .catch(err => console.error('테이블 생성 오류:', err));

// 조회 기록 테이블 생성 쿼리
const createViewsTableQuery = `
    CREATE TABLE IF NOT EXISTS post_views (
        id INT AUTO_INCREMENT PRIMARY KEY,
        post_id INT NOT NULL,
        userId VARCHAR(50) NOT NULL,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
    )
`;

// 테이블 생성
pool.query(createViewsTableQuery)
    .then(() => console.log('post_views 테이블 준비 완료'))
    .catch(err => console.error('테이블 생성 오류:', err));

// 좋아요 테이블 생성 쿼리
const createLikesTableQuery = `
    CREATE TABLE IF NOT EXISTS post_likes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        post_id INT NOT NULL,
        userId VARCHAR(50) NOT NULL,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
        UNIQUE KEY unique_like (post_id, userId)
    )
`;

// 좋아요 테이블 생성
pool.query(createLikesTableQuery)
    .then(() => console.log('post_likes 테이블 준비 완료'))
    .catch(err => console.error('테이블 생성 오류:', err));

// 데이터베이스 연결 테스트
pool.getConnection()
    .then(connection => {
        console.log('데이터베이스 연결 성공');
        connection.release();
    })
    .catch(err => {
        console.error('데이터베이스 연결 오류:', err);
    });

// 게시글 작성
app.post('/api/posts', async (req, res) => {
    try {
        const { title, content, author } = req.body;
        const userId = req.headers.userid;

        console.log('게시글 작성 요청:', { title, content, author, userId });

        const [result] = await pool.query(
            'INSERT INTO posts (title, content, author, userId) VALUES (?, ?, ?, ?)',
            [title, content, author, userId]
        );

        console.log('게시글 생성 결과:', {
            insertId: result.insertId,
            title,
            content,
            author,
            userId
        });

        res.status(201).json({
            success: true,
            data: {
                id: result.insertId,
                title,
                content,
                author,
                userId
            }
        });
    } catch (error) {
        console.error('게시글 작성 오류:', error);
        res.status(500).json({ 
            success: false, 
            message: '게시글 작성 실패' 
        });
    }
});

// 게시글 목록 조회
app.get('/api/posts', async (req, res) => {
    try {
        // 페이지네이션 파라미터
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const offset = (page - 1) * limit;

        console.log('게시글 목록 조회:', { page, limit, offset });
        
        // 전체 게시글 수 조회
        const [totalRows] = await pool.query(
            'SELECT COUNT(*) as count FROM posts'
        );
        
        // 페이지네이션이 적용된 게시글 목록 조회
        const [rows] = await pool.query(`
            SELECT 
                p.*,
                COUNT(c.id) as comment_count,
                (SELECT COUNT(*) FROM post_likes WHERE post_id = p.id) as like_count
            FROM posts p
            LEFT JOIN comments c ON p.id = c.post_id
            GROUP BY p.id
            ORDER BY p.createdAt DESC
            LIMIT ? OFFSET ?
        `, [limit, offset]);
        
        console.log('조회된 게시글:', rows.length);

        res.json({
            success: true,
            data: rows.map(post => ({
                id: post.id,
                title: post.title,
                content: post.content,
                author: post.author,
                userId: post.userId,
                created_at: post.createdAt,
                hits: post.hits || 0,
                comment_count: post.comment_count || 0,
                like_count: post.like_count || 0
            })),
            pagination: {
                total: totalRows[0].count,
                page,
                limit,
                totalPages: Math.ceil(totalRows[0].count / limit)
            }
        });
    } catch (error) {
        console.error('게시글 목록 조회 오류:', error);
        res.status(500).json({ 
            success: false, 
            message: '게시글 목록 조회 실패' 
        });
    }
});

// 게시글 상세 조회
app.get('/api/posts/:id', async (req, res) => {
    try {
        console.log('상세 조회 요청:', {
            id: req.params.id,
            headers: req.headers,
            url: req.url
        });
        
        const [rows] = await pool.query(
            `SELECT p.*, 
                    COUNT(c.id) as comment_count,
                    (SELECT COUNT(*) FROM post_views WHERE post_id = p.id) as hits,
                    (SELECT COUNT(*) FROM post_likes WHERE post_id = p.id) as likeCount,
                    EXISTS(SELECT 1 FROM post_likes WHERE post_id = p.id AND userId = ?) as isLiked
             FROM posts p 
             LEFT JOIN comments c ON p.id = c.post_id 
             WHERE p.id = ?
             GROUP BY p.id`,
            [req.headers.userid, req.params.id]
        );
        
        console.log('데이터베이스 조회 결과:', rows);
        
        if (rows.length === 0) {
            console.log('게시글 없음');
            return res.status(404).json({ 
                success: false,
                message: '게시글을 찾을 수 없습니다.' 
            });
        }

        const responseData = {
            success: true,
            data: {
                id: rows[0].id,
                title: rows[0].title,
                content: rows[0].content,
                author: rows[0].author,
                userId: rows[0].userId,
                created_at: rows[0].createdAt,
                comment_count: rows[0].comment_count || 0,
                hits: rows[0].hits || 0,
                likeCount: rows[0].likeCount || 0,
                isLiked: rows[0].isLiked === 1
            }
        };

        console.log('응답 데이터:', responseData);
        res.json(responseData);
    } catch (error) {
        console.error('게시글 조회 오류:', error);
        res.status(500).json({ 
            success: false, 
            message: '게시글 조회 실패' 
        });
    }
});

// 댓글 목록 조회
app.get('/api/posts/:id/comments', async (req, res) => {
    try {
        const [comments] = await pool.query(
            'SELECT * FROM comments WHERE post_id = ? ORDER BY createdAt DESC',
            [req.params.id]
        );
        
        res.json({
            success: true,
            data: comments.map(comment => ({
                id: comment.id,
                post_id: comment.post_id,
                content: comment.content,
                author: comment.author,
                userId: comment.userId,
                created_at: comment.createdAt
            }))
        });
    } catch (error) {
        console.error('댓글 목록 조회 오류:', error);
        res.status(500).json({
            success: false,
            message: '댓글 목록 조회 실패'
        });
    }
});

// 댓글 작성
app.post('/api/posts/:id/comments', async (req, res) => {
    try {
        const { commentContent } = req.body;
        const userId = req.headers.userid;
        const postId = req.params.id;
        
        // 작성자 정보 조회
        const [users] = await pool.query(
            'SELECT author FROM posts WHERE id = ?',
            [postId]
        );

        const [result] = await pool.query(
            'INSERT INTO comments (post_id, content, author, userId) VALUES (?, ?, ?, ?)',
            [postId, commentContent, users[0].author, userId]
        );

        // 댓글 수 업데이트
        await pool.query(
            'UPDATE posts SET comment_count = (SELECT COUNT(*) FROM comments WHERE post_id = ?) WHERE id = ?',
            [postId, postId]
        );

        res.status(201).json({
            success: true,
            data: {
                id: result.insertId,
                post_id: postId,
                content: commentContent,
                author: users[0].author,
                userId: userId,
                created_at: new Date()
            }
        });
    } catch (error) {
        console.error('댓글 작성 오류:', error);
        res.status(500).json({
            success: false,
            message: '댓글 작성 실패'
        });
    }
});

// 댓글 수정
app.put('/api/posts/:postId/comments/:commentId', async (req, res) => {
    try {
        const { commentContent } = req.body;
        const userId = req.headers.userid;
        const { postId, commentId } = req.params;

        // 댓글 작성자 확인
        const [comment] = await pool.query(
            'SELECT * FROM comments WHERE id = ? AND post_id = ?',
            [commentId, postId]
        );

        if (comment.length === 0) {
            return res.status(404).json({
                success: false,
                message: '댓글을 찾을 수 없습니다.'
            });
        }

        if (comment[0].userId !== userId) {
            return res.status(403).json({
                success: false,
                message: '댓글 수정 권한이 없습니다.'
            });
        }

        await pool.query(
            'UPDATE comments SET content = ? WHERE id = ?',
            [commentContent, commentId]
        );

        res.json({
            success: true,
            data: {
                id: commentId,
                post_id: postId,
                content: commentContent,
                author: comment[0].author,
                userId: userId,
                created_at: comment[0].createdAt
            }
        });
    } catch (error) {
        console.error('댓글 수정 오류:', error);
        res.status(500).json({
            success: false,
            message: '댓글 수정 실패'
        });
    }
});

// 댓글 삭제
app.delete('/api/posts/:postId/comments/:commentId', async (req, res) => {
    try {
        const userId = req.headers.userid;
        const { postId, commentId } = req.params;

        // 댓글 작성자 확인
        const [comment] = await pool.query(
            'SELECT * FROM comments WHERE id = ? AND post_id = ?',
            [commentId, postId]
        );

        if (comment.length === 0) {
            return res.status(404).json({
                success: false,
                message: '댓글을 찾을 수 없습니다.'
            });
        }

        if (comment[0].userId !== userId) {
            return res.status(403).json({
                success: false,
                message: '댓글 삭제 권한이 없습니다.'
            });
        }

        await pool.query('DELETE FROM comments WHERE id = ?', [commentId]);

        // 댓글 수 업데이트
        await pool.query(
            'UPDATE posts SET comment_count = (SELECT COUNT(*) FROM comments WHERE post_id = ?) WHERE id = ?',
            [postId, postId]
        );

        res.json({
            success: true,
            message: '댓글이 삭제되었습니다.'
        });
    } catch (error) {
        console.error('댓글 삭제 오류:', error);
        res.status(500).json({
            success: false,
            message: '댓글 삭제 실패'
        });
    }
});

// 게시글 수정
app.put('/api/posts/:id', async (req, res) => {
    try {
        const { title, content } = req.body;
        const userId = req.headers.userid;
        const postId = req.params.id;

        // 게시글 작성자 확인
        const [post] = await pool.query(
            'SELECT * FROM posts WHERE id = ?',
            [postId]
        );

        if (post.length === 0) {
            return res.status(404).json({
                success: false,
                message: '게시글을 찾을 수 없습니다.'
            });
        }

        if (post[0].userId !== userId) {
            return res.status(403).json({
                success: false,
                message: '게시글 수정 권한이 없습니다.'
            });
        }

        await pool.query(
            'UPDATE posts SET title = ?, content = ? WHERE id = ?',
            [title, content, postId]
        );

        res.json({
            success: true,
            message: '게시글이 수정되었습니다.'
        });
    } catch (error) {
        console.error('게시글 수정 오류:', error);
        res.status(500).json({
            success: false,
            message: '게시글 수정 실패'
        });
    }
});

// 게시글 삭제
app.delete('/api/posts/:id', async (req, res) => {
    try {
        const userId = req.headers.userid;
        const postId = req.params.id;

        if (!userId || !postId) {
            return res.status(400).json({
                success: false,
                message: '필수 파라미터가 누락되었습니다.'
            });
        }

        // 게시글 작성자 확인
        const [post] = await pool.query(
            'SELECT * FROM posts WHERE id = ?',
            [postId]
        );

        if (post.length === 0) {
            return res.status(404).json({
                success: false,
                message: '게시글을 찾을 수 없습니다.'
            });
        }

        if (post[0].userId !== userId) {
            return res.status(403).json({
                success: false,
                message: '게시글 삭제 권한이 없습니다.'
            });
        }

        await pool.query('DELETE FROM posts WHERE id = ?', [postId]);

        res.json({
            success: true,
            message: '게시글이 삭제되었습니다.'
        });
    } catch (error) {
        console.error('게시글 삭제 오류:', error);
        res.status(500).json({
            success: false,
            message: '게시글 삭제 실패'
        });
    }
});

// 조회수 증가 API
app.post('/api/posts/:id/views', async (req, res) => {
    try {
        const postId = req.params.id;
        const userId = req.headers.userid;

        // 최근 1시간 내 조회 기록 확인
        const [recentViews] = await pool.query(
            `SELECT id FROM post_views 
             WHERE post_id = ? AND userId = ? 
             AND createdAt > DATE_SUB(NOW(), INTERVAL 1 HOUR)`,
            [postId, userId]
        );

        // 최근 조회 기록이 없으면 조회수 증가
        if (recentViews.length === 0) {
            // 조회 기록 추가
            await pool.query(
                'INSERT INTO post_views (post_id, userId) VALUES (?, ?)',
                [postId, userId]
            );

            // 게시글 조회수 증가
            await pool.query(
                'UPDATE posts SET hits = hits + 1 WHERE id = ?',
                [postId]
            );
        }

        // 현재 조회수 조회
        const [post] = await pool.query(
            'SELECT hits FROM posts WHERE id = ?',
            [postId]
        );

        res.json({
            success: true,
            data: { views: post[0]?.hits || 0 }
        });
    } catch (error) {
        console.error('조회수 업데이트 오류:', error);
        res.status(500).json({
            success: false,
            message: '조회수 업데이트에 실패했습니다.'
        });
    }
});

// 좋아요 토글 API
app.post('/api/posts/:id/like', async (req, res) => {
    try {
        const postId = req.params.id;
        const userId = req.headers.userid;

        // 이미 좋아요를 눌렀는지 확인
        const [existingLike] = await pool.query(
            'SELECT * FROM post_likes WHERE post_id = ? AND userId = ?',
            [postId, userId]
        );

        let likeCount;

        if (existingLike.length > 0) {
            // 좋아요 취소
            await pool.query(
                'DELETE FROM post_likes WHERE post_id = ? AND userId = ?',
                [postId, userId]
            );
        } else {
            // 좋아요 추가
            await pool.query(
                'INSERT INTO post_likes (post_id, userId) VALUES (?, ?)',
                [postId, userId]
            );
        }

        // 현재 좋아요 수 조회
        const [result] = await pool.query(
            'SELECT COUNT(*) as count FROM post_likes WHERE post_id = ?',
            [postId]
        );

        likeCount = result[0].count;

        res.json({
            success: true,
            likeCount,
            isLiked: !existingLike.length
        });
    } catch (error) {
        console.error('좋아요 처리 오류:', error);
        res.status(500).json({
            success: false,
            message: '좋아요 처리에 실패했습니다.'
        });
    }
});

// 서버 시작
app.listen(PORT, () => {
    console.log(`메인 서버가 http://localhost:${PORT}에서 실행 중입니다`);
});
