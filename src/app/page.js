"use client"
import { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import { motion, AnimatePresence } from 'framer-motion';

// --- CONFIG & CONSTANTS ---
const QUIZ_DATA = {
  title: "SLO BuRN Quiz",
  questions: [
    { text: "What is the largest volcano in our solar system?", timeLimit: 20, options: [{ text: "Mauna Kea", isCorrect: false }, { text: "Mount Everest", isCorrect: false }, { text: "Olympus Mons on Mars", isCorrect: true }, { text: "Tamu Massif", isCorrect: false }] },
    { text: "Which planet is known as the 'Red Planet'?", timeLimit: 15, options: [{ text: "Jupiter", isCorrect: false }, { text: "Mars", isCorrect: true }, { text: "Venus", isCorrect: false }, { text: "Saturn", isCorrect: false }] },
    { text: "What is the chemical symbol for Gold?", timeLimit: 25, options: [{ text: "Au", isCorrect: true }, { text: "Ag", isCorrect: false }, { text: "Gd", isCorrect: false }, { text: "Go", isCorrect: false }] },
  ],
};
const COLORS = ["bg-red-500", "bg-blue-500", "bg-yellow-500", "bg-green-500"];
const SHAPES = ['▲', '◆', '●', '■'];
const PLAYER_ID_KEY = 'quiz-player-id';
const HOST_ID_KEY = 'quiz-host-id';
const GAME_STATE_KEY = 'quiz-game-state';

// --- HELPER FUNCTIONS (Browser-only, call inside useEffect) ---
const getPlayerId = () => {
    let id = localStorage.getItem(PLAYER_ID_KEY);
    if (!id) { id = `player_${Math.random().toString(36).substring(2, 11)}`; localStorage.setItem(PLAYER_ID_KEY, id); }
    return id;
};
const getHostId = () => {
    let id = localStorage.getItem(HOST_ID_KEY);
    if (!id) { id = `host_${Math.random().toString(36).substring(2, 11)}`; localStorage.setItem(HOST_ID_KEY, id); }
    return id;
};

// --- REUSABLE UI COMPONENTS ---
const Background = () => <div className="absolute top-0 left-0 w-full h-full bg-gradient-to-br from-indigo-900 via-purple-900 to-gray-900 -z-10" />;
const Card = ({ children, className = "" }) => (<motion.div initial={{ opacity: 0, y: 50 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -50 }} transition={{ duration: 0.3 }} className={`bg-white/10 backdrop-blur-lg p-8 rounded-2xl shadow-2xl text-white w-full max-w-4xl mx-auto ${className}`}>{children}</motion.div>);
const Button = ({ children, onClick, className = "", ...props }) => (<motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} onClick={onClick} className={`w-full py-4 px-6 bg-purple-600 hover:bg-purple-700 rounded-lg text-xl font-bold transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${className}`} {...props}>{children}</motion.button>);

// --- SYNCHRONIZED TIMER COMPONENT ---
const SyncedTimerBar = ({ game }) => {
    const [percent, setPercent] = useState(100);
    const question = game.quiz.questions[game.currentQuestionIndex];
    
    useEffect(() => {
        if (game.state !== 'QUESTION') return;

        const interval = setInterval(() => {
            const elapsed = Date.now() - game.questionStartTime;
            const remaining = Math.max(0, question.timeLimit * 1000 - elapsed);
            setPercent((remaining / (question.timeLimit * 1000)) * 100);
        }, 50); // Update every 50ms for smooth animation

        return () => clearInterval(interval);
    }, [game.state, game.questionStartTime, question.timeLimit]);

    return (
        <div className="h-4 bg-gray-700 absolute bottom-0 left-0 w-full">
            <motion.div className="h-4 bg-purple-600" style={{ width: `${percent}%` }} />
        </div>
    );
};

// --- GAME VIEW COMPONENTS ---
const HomePage = ({ onHost, onJoin, gameExists }) => {
    const [nickname, setNickname] = useState('');
    return ( <Card> <h1 className="text-5xl font-bold mb-8 text-center">{QUIZ_DATA.title}</h1> {gameExists ? ( <div className="flex flex-col gap-4"> <h2 className="text-2xl font-bold text-center">A Game is in Progress!</h2> <input type="text" placeholder="Enter Your Nickname" value={nickname} onChange={e => setNickname(e.target.value)} className="text-center p-4 rounded-lg bg-white/20 text-2xl font-bold placeholder-white/50 focus:outline-none focus:ring-2 focus:ring-purple-500" /> <Button onClick={() => onJoin(nickname)} disabled={!nickname.trim()}>Join Lobby</Button> </div> ) : ( <div className="flex flex-col gap-4 items-center"> <h2 className="text-2xl text-center text-white/80 mb-4">No active game found.</h2> <Button onClick={onHost} className="bg-green-600 hover:bg-green-700">Host New Game</Button> </div> )} </Card> );
};

const LobbyView = ({ game, isHost, onStart }) => {
    const isHostOnline = !!game.hostSocketId;
    return ( <Card> <h2 className="text-3xl mb-2 font-bold text-center">Game Lobby</h2> {!isHostOnline && <p className="text-center text-yellow-400 animate-pulse mb-4">Host is currently disconnected. Waiting to reconnect...</p>} <h3 className="text-2xl mb-4 text-center">Players ({game.players.filter(p => !p.disconnected).length})</h3> <div className="grid grid-cols-2 md:grid-cols-4 gap-4 min-h-[100px] bg-black/20 p-4 rounded-lg"> <AnimatePresence> {game.players.map(player => ( <motion.div key={player.id} initial={{ opacity: 0, scale: 0.5 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.5 }} className={`p-3 rounded-lg text-center font-semibold overflow-hidden text-ellipsis ${player.disconnected ? 'bg-red-800/50 opacity-50' : 'bg-white/20'}`}> {player.nickname} {player.disconnected ? '(offline)' : ''} </motion.div> ))} </AnimatePresence> </div> {isHost && <div className="mt-8"><Button onClick={onStart} disabled={game.players.length === 0 || !isHostOnline}>Start Game</Button></div>} {!isHost && <p className="text-center mt-8 text-xl animate-pulse">Waiting for host to start...</p>} </Card> );
};

const QuestionView = ({ game, isHost, onAnswer, me, onNext, onPause }) => {
    const question = game.quiz.questions[game.currentQuestionIndex];
    const hasAnswered = me?.answered;
    
    return ( <div className="w-full"> <Card className="text-center relative pb-8 overflow-hidden"> <div className="flex justify-between items-center text-2xl font-bold mb-4"> <span>Q: {game.currentQuestionIndex + 1}/{game.quiz.questions.length}</span> <span>{me ? `${me.nickname}: ${me.score}` : 'Host View'}</span> </div> <h2 className="text-4xl font-bold my-10 min-h-[100px] flex items-center justify-center">{question.text}</h2> {isHost && ( <div className="flex flex-col gap-4"> <div className="w-full bg-gray-700 rounded-full h-2.5"> <motion.div className="bg-green-500 h-2.5 rounded-full" initial={{ width: 0 }} animate={{ width: `${(game.players.filter(p => p.answered).length / game.players.length) * 100}%` }} /> </div> <div className="grid grid-cols-2 gap-4"> <Button onClick={onPause} className="bg-yellow-600 hover:bg-yellow-700">Pause Game</Button> <Button onClick={onNext}>Show Results</Button> </div> </div> )} <SyncedTimerBar game={game} /> </Card> {!isHost && ( <div className="mt-4"> {hasAnswered ? <Card><p className="text-center text-2xl animate-pulse">Answer locked in! Waiting for others...</p></Card> : ( <div className="grid grid-cols-2 gap-4"> {question.options.map((opt, i) => ( <motion.button key={i} onClick={() => onAnswer(i)} className={`flex items-center p-4 rounded-lg text-xl text-left font-bold h-full ${COLORS[i]}`} whileHover={{ scale: 1.02 }} whileTap={{scale: 0.98}}> <span className="text-4xl mr-4">{SHAPES[i]}</span> <span className="flex-1">{opt.text}</span> </motion.button> ))} </div> )} </div> )} </div> );
};

const PausedView = ({ isHost, onResume }) => ( <Card> <h2 className="text-4xl font-bold text-center mb-6 animate-pulse">Game Paused</h2> {isHost && <Button onClick={onResume} className="bg-green-600 hover:bg-green-700">Resume Game</Button>} {!isHost && <p className="text-center text-xl">The host has paused the game. Please wait.</p>} </Card> );

const LeaderboardView = ({ game, isHost, onNext, prevGame }) => {
    const playersSorted = [...game.players].sort((a, b) => b.score - a.score); const question = game.quiz.questions[game.currentQuestionIndex]; const correctOption = question.options.find(o => o.isCorrect); const getScoreChange = (playerId) => { const prevPlayer = prevGame?.players.find(p => p.id === playerId); const currentPlayer = game.players.find(p => p.id === playerId); if (!prevPlayer || !currentPlayer) return 0; return currentPlayer.score - prevPlayer.score; }; return ( <Card> <h2 className="text-4xl font-bold text-center mb-6">Leaderboard</h2> <div className="p-4 rounded-lg text-center mb-6 text-xl bg-green-500/80 font-bold">Correct Answer: {correctOption?.text}</div> <div className="space-y-3"> {playersSorted.map((player, i) => { const scoreChange = getScoreChange(player.id); return ( <motion.div key={player.id} layout initial={{ opacity: 0, x: -100 }} animate={{ opacity: 1, x: 0, transition: { delay: i * 0.1 } }} className={`flex justify-between items-center bg-white/20 p-4 rounded-lg ${player.disconnected ? 'opacity-50' : ''}`}> <div className="flex items-center"> <span className="text-2xl font-bold w-12">{i + 1}.</span> <span className="text-2xl">{player.nickname}</span> </div> <div className="flex items-center"> {scoreChange > 0 && <motion.span initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="text-green-400 mr-4 text-xl">+{scoreChange}</motion.span>} <span className="text-2xl font-bold">{player.score}</span> </div> </motion.div> ); })} </div> {isHost && <div className="mt-8"><Button onClick={onNext}>Next</Button></div>} </Card> );
};

const FinishedView = ({ game, isHost, onHostNew }) => {
    const playersSorted = [...game.players].sort((a, b) => b.score - a.score); const podiumColors = ['bg-yellow-500', 'bg-gray-400', 'bg-yellow-700']; const podiumIcons = ['🥇', '🥈', '🥉']; return ( <Card> <h2 className="text-5xl font-bold text-center mb-8">Final Results!</h2> <div className="space-y-4"> {playersSorted.slice(0, 3).map((player, i) => ( <motion.div key={player.id} initial={{ scale: 0 }} animate={{ scale: 1, transition: { delay: i * 0.2, type: "spring", stiffness: 200 } }} className={`flex items-center justify-between p-6 rounded-lg font-bold text-3xl ${podiumColors[i]}`}> <span>{podiumIcons[i]} {player.nickname}</span> <span>{player.score}</span> </motion.div> ))} </div> {isHost && <div className="mt-8"><Button onClick={onHostNew} className="bg-green-600 hover:bg-green-700">Play Again</Button></div>} </Card> );
}

// --- MAIN PAGE COMPONENT ---
export default function QuizGamePage() {
    const [playerId, setPlayerId] = useState(null);
    const [hostId, setHostId] = useState(null);
    const [socket, setSocket] = useState(null);
    const [game, setGame] = useState(null);
    const [connectionStatus, setConnectionStatus] = useState('connecting');
    const [isInitialized, setIsInitialized] = useState(false);
    const prevGameRef = useRef(null);

    // This effect runs once on the client to initialize IDs, state, and the socket connection.
    useEffect(() => {
        // This code only runs on the client-side
        const resolvedPlayerId = getPlayerId();
        const resolvedHostId = getHostId();
        setPlayerId(resolvedPlayerId);
        setHostId(resolvedHostId);

        try {
            const savedGame = localStorage.getItem(GAME_STATE_KEY);
            if (savedGame) setGame(JSON.parse(savedGame));
        } catch (e) {
            console.error("Failed to parse game state from localStorage", e);
            localStorage.removeItem(GAME_STATE_KEY);
        }

        const serverUrl = process.env.NODE_ENV === 'production' ? window.location.origin : 'http://localhost:3000';
        const newSocket = io(serverUrl);
        setSocket(newSocket);
    
        newSocket.on('connect', () => {
            console.log('Socket connected!', newSocket.id);
            setConnectionStatus('connected');
            const lastGameState = JSON.parse(localStorage.getItem(GAME_STATE_KEY));
            
            if (lastGameState?.hostId === resolvedHostId) {
                console.log('Rejoining as host...');
                newSocket.emit('host:rejoin', { hostId: resolvedHostId });
            } else if (lastGameState?.players.some(p => p.id === resolvedPlayerId)) {
                console.log('Rejoining as player...');
                newSocket.emit('player:rejoin', { playerId: resolvedPlayerId });
            } else {
                newSocket.emit('game:get-state');
            }
        });
    
        newSocket.on('disconnect', () => setConnectionStatus('error'));
        newSocket.on('connect_error', () => setConnectionStatus('error'));

        setIsInitialized(true);

        return () => newSocket.disconnect();
    }, []);

    // This effect manages game state updates from the socket.
    useEffect(() => {
        if (!socket) return;
        
        const handleGameUpdate = (updatedGame) => {
            prevGameRef.current = game;
            setGame(updatedGame);
            if (updatedGame) { localStorage.setItem(GAME_STATE_KEY, JSON.stringify(updatedGame)); } 
            else { localStorage.removeItem(GAME_STATE_KEY); }
        };
        const handleGameEnded = (message) => { alert(message); setGame(null); localStorage.removeItem(GAME_STATE_KEY); }

        socket.on('game:update', handleGameUpdate);
        socket.on('game:error', (message) => alert(`Error: ${message}`));
        socket.on('game:ended', handleGameEnded);
        
        return () => { socket.off('game:update'); socket.off('game:error'); socket.off('game:ended'); };
    }, [socket, game]);
    
    const isHost = game?.hostId === hostId;
    const me = game?.players.find(p => p.id === playerId);
    const amInGame = !!me;

    const handleHost = () => { if(socket) { localStorage.setItem(HOST_ID_KEY, hostId); socket.emit('host:create', { quizData: QUIZ_DATA, hostId }); }};
    const handleJoin = (nickname) => socket?.emit('player:join', { nickname, playerId });
    const handleStart = () => socket?.emit('game:start');
    const handleAnswer = (answerIndex) => socket?.emit('player:answer', { playerId, answerIndex });
    const handleNext = () => socket?.emit('game:next');
    const handleTogglePause = () => socket?.emit('host:toggle-pause');

    const renderView = () => {
        if (!isInitialized) return <Card><p className="text-center animate-pulse text-2xl">Initializing...</p></Card>;
        if (connectionStatus === 'connecting') return <Card><p className="text-center animate-pulse text-2xl">Connecting...</p></Card>;
        if (connectionStatus === 'error') return <Card><p className="text-center text-red-400 text-2xl">Connection lost. Please refresh.</p></Card>;
        
        if (game && (isHost || amInGame)) {
            switch (game.state) {
                case 'PAUSED': return <PausedView isHost={isHost} onResume={handleTogglePause} />;
                case 'LOBBY': return <LobbyView game={game} isHost={isHost} onStart={handleStart} />;
                case 'QUESTION': return <QuestionView game={game} isHost={isHost} onAnswer={handleAnswer} me={me} onNext={handleNext} onPause={handleTogglePause} />;
                case 'LEADERBOARD': return <LeaderboardView game={game} isHost={isHost} onNext={handleNext} prevGame={prevGameRef.current} />;
                case 'FINISHED': return <FinishedView game={game} isHost={isHost} onHostNew={handleHost} />;
                default: return <HomePage onHost={handleHost} onJoin={handleJoin} gameExists={!!game} />;
            }
        }
        
        return <HomePage onHost={handleHost} onJoin={handleJoin} gameExists={game?.state === 'LOBBY'} />;
    };

    const animationKey = game ? `${game.state}-${game.currentQuestionIndex}` : 'home';

    return (
        <main className="flex min-h-screen flex-col items-center justify-center p-4 overflow-hidden">
            <Background />
            <AnimatePresence mode="wait">
                <div key={animationKey} className="w-full flex justify-center">
                    {renderView()}
                </div>
            </AnimatePresence>
        </main>
    );
}