import { Vajra, cors, rateLimit } from './packages/vajra/src/index';
import { helmet } from './packages/vajra/src/security/helmet';
import { requestId } from './packages/vajra/src/security/request-id';

const app = new Vajra();
app.use(helmet());
app.use(requestId());
app.use(cors({ origin: '*' }));
app.use(rateLimit({ max: 10_000_000 }));
app.get('/json', (c) => c.json({ message: 'Hello, World!' }));

app.listen(3001);
console.log('Vajra full-features: http://localhost:3001/json');
console.log('Stack: helmet + requestId + cors + rateLimit');
