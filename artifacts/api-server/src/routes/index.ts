import { Router, type IRouter } from "express";
import healthRouter from "./health";
import tokensRouter from "./tokens";
import poolsRouter from "./pools";
import swapRouter from "./swap";
import marketRouter from "./market";
import portfolioRouter from "./portfolio";
import transactionsRouter from "./transactions";
import stellarRouter from "./stellar";
import eventsRouter from "./events";

const router: IRouter = Router();

router.use(healthRouter);
router.use(tokensRouter);
router.use(poolsRouter);
router.use(swapRouter);
router.use(marketRouter);
router.use(portfolioRouter);
router.use(transactionsRouter);
router.use(stellarRouter);
router.use(eventsRouter);

export default router;
