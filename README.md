# Docker Code Runner 🐳⚙️

A scalable, language-agnostic code execution engine using Docker containers to compile and run untrusted code safely. Built with Node.js, BullMQ, Redis, and Docker.

## 🚀 Features

- Supports multiple languages: **C, C++, Python, Java, Node.js**
- Executes user-submitted code securely in **isolated Docker containers**
- Uses **BullMQ** for job queuing and processing
- Monitors and logs job execution
- Memory and CPU limits per container
- Automatic cleanup of temporary files

## 📦 Supported Languages

| Language | Docker Image | File Extension | Command |
|---------|---------------|----------------|---------|
| C       | `gcc:13`      | `.c`           | `gcc file.c -o output && ./output` |
| C++     | `gcc:13`      | `.cpp`         | `g++ file.cpp -o output && ./output` |
| Python  | `python:3`    | `.py`          | `python3 file.py` |
| Java    | `openjdk:17`  | `.java`        | `javac file.java && java ClassName` |
| Node.js | `node:20`     | `.js`          | `node file.js` |

> ✅ Java class name is automatically extracted from code to name the file correctly.

## 🛠️ How It Works

1. A job with user-submitted code and language is pushed into the queue.
2. The worker:
   - Writes the code to a temp file
   - Determines the right Docker image and command
   - Executes the code inside a secure, resource-limited container
   - Returns the result or error output
   - Cleans up all temporary files

## 📁 Project Structure

```
project-root/
├── worker.js            # BullMQ worker handling execution
├── queue.js             # Queue setup and job submission
├── languages.js         # Language config (images, commands)
├── volume/              # Mounted Docker volume for code files
└── utils/
    └── cleanup.js       # Utility for deleting temp files
```

## 🧪 Example Usage

```js
await codeQueue.add('code-execution', {
	language: 'python',
	code: 'print("Hello from Python!")',
});
```

## ⚙️ Configuration

Set these environment variables or constants:

```env
DOCKER_MEM_LIMIT=256m
DOCKER_CPU_LIMIT=0.5
VOLUME_NAME=code_execution_volume
CODE_DIR=/path/to/volume
```

> Make sure the Docker volume is created:
```bash
docker volume create code_execution_volume
```

## 🧼 Security Notes

- Containers are **run without network access** for isolation.
- No user input is executed on the host.
- Output is limited and execution is time-bound to avoid abuse.

## 🐾 Future Improvements

- Add language: Go, Ruby, Rust
- Result caching
- User-authenticated job tracking
- Web-based playground UI
