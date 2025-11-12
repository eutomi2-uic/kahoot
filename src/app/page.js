"use client"
import { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import { motion, AnimatePresence } from 'framer-motion';

// --- STATIC QUIZ DATA ---
const QUIZ_DATA = {
  title: "SLO BURN Quiz",
  questions: [
    {
      text: "What is the largest volcano in our solar system?",
      timeLimit: 20,
      options: [
        { text: "Mauna Kea", isCorrect: false },
        { text: "Mount Everest", isCorrect: false },
        { text: "Olympus Mons on Mars", isCorrect: true },
        { text: "Tamu Massif", isCorrect: false },
      ],
    },
    {
      text: "Which planet is known for its prominent rings?",
      timeLimit: 15,
      options: [
        { text: "Jupiter", isCorrect: false },
        { text: "Saturn", isCorrect: true },
        { text: "Neptune", isCorrect: false },
        { text: "Uranus", isCorrect: false },
      ],
    },
    {
      text: "What phenomenon allows us to see images of very distant galaxies?",
      timeLimit: 25,
      options: [
        { text: "Gravitational Lensing", isCorrect: true },
        { text: "Quantum Tunneling", isCorrect: false },
        { text: "Stellar Parallax", isCorrect: false },
        { text: "Doppler Effect", isCorrect: false },
      ],
    },
  ],
};
const COLORS = ["bg-red-500", "bg-blue-500", "bg-yellow-500", "bg-green-500"];
const SHAPES = ["▲", "◆", "●", "■"];

// --- HELPER FUNCTIONS ---
const getPlayerId = () => {
    let id = localStorage.getItem('kahoot-player-id');
    if (!id) {
        id = `player_${Math.random().toString(36).substr(2, 9)}`;
        localStorage.setItem('kahoot-player-id', id);
    }
    return id;
};

// --- REUSABLE UI COMPONENTS ---
const Background = () => <div className="absolute top-0 left-0 w-full h-full bg-gradient-to-br from-indigo-900 via-purple-900 to-gray-900 -z-10" />;
const Card = ({ children, className = "" }) => (
    <motion.div initial={{ opacity: 0, y: 50 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -50 }} transition={{ duration: 0.3 }} className={`bg-white/10 backdrop-blur-lg p-8 rounded-2xl shadow-2xl text-white w-full max-w-2xl mx-auto ${className}`}>
        {children}
    </motion.div>
);
const Button = ({ children, onClick, className = "", ...props }) => (
    <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} onClick={onClick} className={`w-full py-4 px-6 bg-purple-600 hover:bg-purple-700 rounded-lg text-xl font-bold transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${className}`} {...props}>
        {children}
    </motion.button>
);

// --- NEW SIMPLIFIED HOME PAGE ---
const HomePage = ({ onHost, onJoin, gameExists }) => {
    const [nickname, setNickname] = useState('');

    return (
        <Card>
            <h1 className="text-5xl font-bold mb-8 text-center">{QUIZ_DATA.title}</h1>
            {gameExists ? (
                <div className="flex flex-col gap-4">
                    <h2 className="text-2xl font-bold text-center">A Game is in Progress!</h2>
                    <input
                        type="text"
                        placeholder="Enter Your Nickname"
                        value={nickname}
                        onChange={e => setNickname(e.target.value)}
                        className="text-center p-4 rounded-lg bg-white/20 text-2xl font-bold placeholder-white/50 focus:outline-none focus:ring-2 focus:ring-purple-500"
                    />
                    <Button onClick={() => onJoin(nickname)} disabled={!nickname}>
                        Join Lobby
                    </Button>
                </div>
            ) : (
                <div className="flex flex-col gap-4 items-center">
                    <h2 className="text-2xl text-center text-white/80 mb-4">No active game found.</h2>
                    <Button onClick={onHost} className="bg-green-600 hover:bg-green-700">
                        Host New Game
                    </Button>
                </div>
            )}
        </Card>
    );
};

// --- OTHER GAME VIEW COMPONENTS (Unchanged, but included for completeness) ---
const LobbyView = ({ game, isHost, onStart }) => (
    <Card className="max-w-4xl">
        <h2 className="text-3xl mb-6 font-bold text-center">Game Lobby</h2>
        <h3 className="text-2xl mb-4 text-center">Players ({game.players.length})</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 min-h-[100px] bg-black/20 p-4 rounded-lg">
            <AnimatePresence>
                {game.players.map(player => (
                    <motion.div key={player.id} initial={{ opacity: 0, scale: 0.5 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.5 }} className="bg-white/20 p-3 rounded-lg text-center font-semibold overflow-hidden text-ellipsis">
                        {player.nickname}
                    </motion.div>
                ))}
            </AnimatePresence>
        </div>
        {isHost && <div className="mt-8"><Button onClick={onStart} disabled={game.players.length === 0}>Start Game ({game.players.length} players)</Button></div>}
        {!isHost && <p className="text-center mt-8 text-xl animate-pulse">Waiting for host to start the game...</p>}
    </Card>
);
const QuestionView = ({ game, isHost, onAnswer }) => {
    const question = game.quiz.questions[game.currentQuestionIndex];
    const playerId = getPlayerId();
    const me = game.players.find(p => p.id === playerId);
    const hasAnswered = me?.answered;
    return (
        <div className="w-full max-w-4xl mx-auto">
            <Card className="text-center relative pb-8">
                <div className="flex justify-between items-center text-2xl font-bold mb-4">
                    <span>Q: {game.currentQuestionIndex + 1}/{game.quiz.questions.length}</span>
                    <span>{me ? `${me.nickname}: ${me.score}` : 'Host View'}</span>
                </div>
                <motion.div key={game.currentQuestionIndex} initial={{ width: '100%' }} animate={{ width: '0%' }} transition={{ duration: question.timeLimit, ease: 'linear' }} className="h-4 bg-purple-600 absolute bottom-0 left-0" />
                <h2 className="text-4xl font-bold my-10 min-h-[100px] flex items-center justify-center">{question.text}</h2>
                {isHost && (
                    <div>
                        <h3 className="text-2xl">Players Answered</h3>
                        <div className="w-full bg-gray-700 rounded-full h-8 mt-2 overflow-hidden">
                            <motion.div className="bg-green-500 h-8 rounded-full text-black font-bold flex items-center justify-end pr-4" initial={{ width: 0 }} animate={{ width: `${(game.players.filter(p => p.answered).length / game.players.length) * 100}%` }}>
                                {game.players.filter(p => p.answered).length} / {game.players.length}
                            </motion.div>
                        </div>
                    </div>
                )}
            </Card>
            {!isHost && (
                <div className="mt-4">
                    {hasAnswered ? <Card><p className="text-center text-2xl animate-pulse">You've answered! Waiting for others...</p></Card> : (
                        <div className="grid grid-cols-2 gap-4">
                            {question.options.map((opt, i) => (
                                <motion.button key={i} onClick={() => onAnswer(i)} className={`flex items-center justify-center h-32 rounded-lg text-6xl font-bold ${COLORS[i]}`} whileHover={{ scale: 1.05 }}>
                                    {SHAPES[i]}
                                </motion.button>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};
const LeaderboardView = ({ game, isHost, onNext, prevGame }) => {
    const playersSorted = [...game.players].sort((a, b) => b.score - a.score);
    const question = game.quiz.questions[game.currentQuestionIndex];
    const correctOption = question.options.find(o => o.isCorrect);
    const getScoreChange = (playerId) => {
        const prevPlayer = prevGame?.players.find(p => p.id === playerId);
        const currentPlayer = game.players.find(p => p.id === playerId);
        if (!prevPlayer || !currentPlayer) return 0;
        return currentPlayer.score - prevPlayer.score;
    };
    return (
        <Card className="max-w-4xl">
            <h2 className="text-4xl font-bold text-center mb-6">Leaderboard</h2>
            <div className="p-4 rounded-lg text-center mb-6 text-xl bg-green-500/80">Correct Answer: {correctOption?.text}</div>
            <div className="space-y-3">
                {playersSorted.map((player, i) => {
                    const scoreChange = getScoreChange(player.id);
                    return (
                        <motion.div key={player.id} layout initial={{ opacity: 0, x: -100 }} animate={{ opacity: 1, x: 0, transition: { delay: i * 0.1 } }} className="flex justify-between items-center bg-white/20 p-4 rounded-lg">
                            <div className="flex items-center">
                                <span className="text-2xl font-bold w-12">{i + 1}.</span>
                                <span className="text-2xl">{player.nickname}</span>
                                {player.id === game.firstCorrectPlayerId && <span className="ml-3 text-yellow-300 text-2xl" title="First Correct Answer!">⚡️</span>}
                            </div>
                            <div className="flex items-center">
                                {scoreChange > 0 && <motion.span initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="text-green-400 mr-4 text-xl">+{scoreChange}</motion.span>}
                                <span className="text-2xl font-bold">{player.score}</span>
                            </div>
                        </motion.div>
                    );
                })}
            </div>
            {isHost && <div className="mt-8"><Button onClick={onNext}>Next</Button></div>}
        </Card>
    );
};
const FinishedView = ({ game, isHost, onHostNew }) => {
    const playersSorted = [...game.players].sort((a, b) => b.score - a.score);
    const podiumColors = ['bg-yellow-500', 'bg-gray-400', 'bg-yellow-700'];
    const podiumIcons = ['🥇', '🥈', '🥉'];
    return (
        <Card className="max-w-4xl">
            <h2 className="text-5xl font-bold text-center mb-8">Final Results!</h2>
            <div className="space-y-4">
                {playersSorted.slice(0, 3).map((player, i) => (
                    <motion.div key={player.id} initial={{ scale: 0 }} animate={{ scale: 1, transition: { delay: i * 0.2, type: "spring", stiffness: 200 } }} className={`flex items-center justify-between p-6 rounded-lg font-bold text-3xl ${podiumColors[i]}`}>
                        <span>{podiumIcons[i]} {player.nickname}</span>
                        <span>{player.score}</span>
                    </motion.div>
                ))}
            </div>
            {isHost && <div className="mt-8"><Button onClick={onHostNew} className="bg-green-600 hover:bg-green-700">Play Again</Button></div>}
        </Card>
    );
}

// --- MAIN PAGE COMPONENT ---
export default function KahootGamePage() {
    const [view, setView] = useState('HOME');
    const [game, setGame] = useState(null);
    const [socket, setSocket] = useState(null);
    const [playerId, setPlayerId] = useState('');
    const [connectionStatus, setConnectionStatus] = useState('connecting');
    const prevGameRef = useRef(null);

    useEffect(() => {
        const id = getPlayerId();
        setPlayerId(id);

        const serverUrl = process.env.NODE_ENV === 'production' ? window.location.origin : 'http://localhost:3000';
        const newSocket = io(serverUrl, { transports: ['websocket'] }); // More reliable connection
        setSocket(newSocket);
    
        newSocket.on('connect', () => {
            console.log('Socket connected!', newSocket.id);
            setConnectionStatus('connected');
            newSocket.emit('game:get-state'); // Ask for game state on connect
        });
    
        newSocket.on('disconnect', () => {
            console.log('Socket disconnected.');
            setConnectionStatus('error');
            alert('Disconnected from the server. Please refresh the page.');
            setGame(null);
            setView('HOME');
        });

        newSocket.on('connect_error', (err) => {
            console.error('Socket connection error:', err);
            setConnectionStatus('error');
        });

        return () => newSocket.disconnect();
    }, []);

    useEffect(() => {
        if (!socket) return;
        
        const handleGameUpdate = (updatedGame) => {
            prevGameRef.current = game;
            setGame(updatedGame);

            if (updatedGame) {
                const amIPlayer = updatedGame.players.some(p => p.id === playerId);
                const amIHost = socket.id === updatedGame.hostId;
                if (amIPlayer || amIHost) {
                    setView(updatedGame.state);
                } else {
                    setView('HOME'); // If not a participant, stay on home screen
                }
            } else {
                setView('HOME'); // Game ended or doesn't exist
            }
        };

        socket.on('game:update', handleGameUpdate);
        socket.on('game:error', (message) => alert(`Error: ${message}`));
        socket.on('game:ended', (message) => {
            alert(message);
            setGame(null);
            setView('HOME');
        });

        return () => {
            socket.off('game:update', handleGameUpdate);
            socket.off('game:error');
            socket.off('game:ended');
        };
    }, [socket, game, playerId]);
    
    const isHost = socket && game && game.hostId === socket.id;

    const handleHost = () => socket?.emit('host:create', QUIZ_DATA);
    const handleJoin = (nickname) => socket?.emit('player:join', { nickname, playerId });
    const handleStart = () => socket?.emit('game:start');
    const handleAnswer = (answerIndex) => socket?.emit('player:answer', { playerId, answerIndex });
    const handleNext = () => socket?.emit('game:next');

    const renderView = () => {
        if (connectionStatus === 'connecting') return <Card><p className="text-center animate-pulse text-2xl">Connecting to server...</p></Card>;
        if (connectionStatus === 'error') return <Card><p className="text-center text-red-400 text-2xl">Connection failed. Please refresh.</p></Card>;
        
        switch (view) {
            case 'LOBBY': return <LobbyView game={game} isHost={isHost} onStart={handleStart} />;
            case 'QUESTION': return <QuestionView game={game} isHost={isHost} onAnswer={handleAnswer} />;
            case 'LEADERBOARD': return <LeaderboardView game={game} isHost={isHost} onNext={handleNext} prevGame={prevGameRef.current} />;
            case 'FINISHED': return <FinishedView game={game} isHost={isHost} onHostNew={handleHost} />;
            default: return <HomePage onHost={handleHost} onJoin={handleJoin} gameExists={game?.state === 'LOBBY'} />;
        }
    };

    return (
        <main className="flex min-h-screen flex-col items-center justify-center p-4 overflow-hidden">
            <Background />
            <AnimatePresence mode="wait">
                <div key={view + (game?.currentQuestionIndex || '')} className="w-full flex justify-center">
                    {renderView()}
                </div>
            </AnimatePresence>
        </main>
    );
}