const { createServer } = require('http');
const next = require('next');
const { Server } = require('socket.io');

const dev = process.env.NODE_ENV !== 'production';
// CHANGE 1: Remove the hardcoded hostname. We will listen on 0.0.0.0 instead.
// const hostname = 'localhost'; 
const port = process.env.PORT || 3000; // CHANGE 2: Use the PORT environment variable provided by DigitalOcean, or default to 3000 for local development.

const app = next({ dev }); // CHANGE 3: When deployed, Next.js doesn't need the hostname/port here. It detects it automatically.
const handler = app.getRequestHandler();

let currentGame = null;
const GAME_ROOM = 'quiz-game-room';

app.prepare().then(() => {
  const httpServer = createServer(handler);

  const io = new Server(httpServer, {
    cors: { origin: "*", methods: ["GET", "POST"] }
  });

  console.log('Socket.IO server initialized.');

  // ... the rest of your Socket.IO logic remains exactly the same ...
  const getPublicGameState = () => {
    if (!currentGame) return null;
    const isQuestionState = currentGame.state === 'QUESTION';
    
    const publicQuiz = {
      ...currentGame.quiz,
      questions: currentGame.quiz.questions.map(q => ({
        ...q,
        options: isQuestionState
          ? q.options.map(({ text }) => ({ text }))
          : q.options,
      })),
    };

    return {
      ...currentGame,
      quiz: publicQuiz,
      players: Array.from(currentGame.players.values()),
    };
  };

  const broadcastGameState = () => {
    io.to(GAME_ROOM).emit('game:update', getPublicGameState());
  };
  
  io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);
    socket.join(GAME_ROOM);

    socket.on('game:get-state', () => {
      socket.emit('game:update', getPublicGameState());
    });

    socket.on('host:create', ({ quizData, hostId }) => {
      console.log(`Host ${hostId} (Socket: ${socket.id}) is creating a new game.`);
      if (currentGame) {
        io.to(GAME_ROOM).emit('game:ended', 'The host has started a new game.');
      }

      currentGame = {
        hostId: hostId,
        hostSocketId: socket.id,
        quiz: quizData, 
        state: 'LOBBY', 
        players: new Map(),
        currentQuestionIndex: 0, 
        questionStartTime: null,
        stateBeforePause: null,
        timeRemainingOnPause: null,
      };
      
      console.log('New game created. State: LOBBY');
      broadcastGameState();
    });

    socket.on('host:rejoin', ({ hostId }) => {
        if (currentGame && currentGame.hostId === hostId) {
            console.log(`Host ${hostId} has rejoined with new socket ${socket.id}`);
            currentGame.hostSocketId = socket.id;
            broadcastGameState();
        }
    });

    socket.on('player:join', ({ nickname, playerId }) => {
      if (!currentGame) return socket.emit('game:error', 'No game is currently active.');
      if (currentGame.state !== 'LOBBY') return socket.emit('game:error', 'Game has already started.');
      if (Array.from(currentGame.players.values()).some(p => p.nickname.toLowerCase() === nickname.toLowerCase())) {
        return socket.emit('game:error', 'This nickname is already taken.');
      }

      console.log(`Player joining: ${nickname} (${playerId})`);
      const player = { id: playerId, socketId: socket.id, nickname, score: 0, answered: false, disconnected: false };
      currentGame.players.set(playerId, player);
      broadcastGameState();
    });

    socket.on('player:rejoin', ({ playerId }) => {
      if (!currentGame || !currentGame.players.has(playerId)) {
         return socket.emit('game:ended', 'The game you were in has ended.');
      }
      const player = currentGame.players.get(playerId);
      player.socketId = socket.id;
      player.disconnected = false;
      console.log(`Player rejoining: ${player.nickname} (${playerId})`);
      socket.emit('game:update', getPublicGameState());
      broadcastGameState();
    });

    socket.on('game:start', () => {
      if (currentGame && currentGame.hostSocketId === socket.id && currentGame.state === 'LOBBY') {
        console.log('Game starting...');
        currentGame.state = 'QUESTION';
        currentGame.questionStartTime = Date.now();
        broadcastGameState();
      }
    });

    socket.on('host:toggle-pause', () => {
        if (!currentGame || currentGame.hostSocketId !== socket.id) return;

        if (currentGame.state === 'PAUSED') {
            console.log('Resuming game.');
            currentGame.state = currentGame.stateBeforePause;
            const timeLimit = currentGame.quiz.questions[currentGame.currentQuestionIndex].timeLimit * 1000;
            currentGame.questionStartTime = Date.now() - (timeLimit - currentGame.timeRemainingOnPause);
            currentGame.stateBeforePause = null;
            currentGame.timeRemainingOnPause = null;
        } else {
            console.log('Pausing game.');
            currentGame.stateBeforePause = currentGame.state;
            if (currentGame.state === 'QUESTION') {
                const elapsed = Date.now() - currentGame.questionStartTime;
                const timeLimit = currentGame.quiz.questions[currentGame.currentQuestionIndex].timeLimit * 1000;
                currentGame.timeRemainingOnPause = Math.max(0, timeLimit - elapsed);
            }
            currentGame.state = 'PAUSED';
        }
        broadcastGameState();
    });

    socket.on('player:answer', ({ playerId, answerIndex }) => {
      if (!currentGame || currentGame.state !== 'QUESTION') return;
      
      const player = currentGame.players.get(playerId);
      const question = currentGame.quiz.questions[currentGame.currentQuestionIndex];

      if (player && !player.answered) {
        player.answered = true;
        const isCorrect = question.options[answerIndex]?.isCorrect;

        if (isCorrect) {
          const timeTaken = (Date.now() - currentGame.questionStartTime) / 1000;
          const timeLimit = question.timeLimit;
          let points = Math.round(Math.max(0, 1000 * (1 - (timeTaken / (timeLimit * 2)))));
          player.score += points;
        }
        broadcastGameState();
      }
    });

    socket.on('game:next', () => {
      if (!currentGame || currentGame.hostSocketId !== socket.id) return;

      if (currentGame.state === 'QUESTION') {
        currentGame.state = 'LEADERBOARD';
      } else if (currentGame.state === 'LEADERBOARD') {
        if (currentGame.currentQuestionIndex < currentGame.quiz.questions.length - 1) {
          currentGame.currentQuestionIndex++;
          currentGame.state = 'QUESTION';
          currentGame.questionStartTime = Date.now();
          currentGame.players.forEach(p => p.answered = false); 
        } else {
          currentGame.state = 'FINISHED';
        }
      }
      broadcastGameState();
    });

    socket.on('disconnect', () => {
      console.log(`Client disconnected: ${socket.id}`);
      if (!currentGame) return;

      if (socket.id === currentGame.hostSocketId) {
        console.log('Host disconnected. The game will persist.');
        currentGame.hostSocketId = null;
        broadcastGameState();
      } else {
        let player = null;
        for (const p of currentGame.players.values()) {
          if (p.socketId === socket.id) {
            player = p;
            break;
          }
        }
        if (player) {
          console.log(`Player ${player.nickname} disconnected.`)
          player.disconnected = true;
          broadcastGameState();
        }
      }
    });
  });

  httpServer
    .once('error', (err) => {
      console.error(err);
      process.exit(1);
    })
    // CHANGE 4: Listen on 0.0.0.0 to accept connections from the platform's proxy.
    .listen(port, () => {
      console.log(`> Ready on http://0.0.0.0:${port}`);
    });
});