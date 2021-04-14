require('express-async-errors')
import * as express from "express";
import * as bodyParser from "body-parser";
import * as cookieParser from "cookie-parser";
import * as morgan from "morgan";
import * as cors from "cors";
import * as http from "http";
import { ResponseData } from "./@types/ResponseData";


const { JWT_COOKIE_SECRET, PORT } = process.env

const app = express();
const server = new http.Server(app);

app.use(morgan('dev'))
app.use(cors({ credentials: true, origin: (origin, cb) => cb(null, true) }))
app.use(bodyParser.json())
app.use(bodyParser.urlencoded({ extended: false }))
app.use(cookieParser(JWT_COOKIE_SECRET));

// ERROR HANDLE
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error(err?.toString())
    const data = new ResponseData(undefined, { code: err.errorCode || 'UNKNOW_ERROR', message: err.message, stack: err.stack })
    res.json(data)
})

async function startServer() {
    server.listen(PORT, () => console.info("Server listening on port " + PORT));
}

startServer();
