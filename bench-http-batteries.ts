import { Vajra, cors, rateLimit } from './packages/vajra/src/index';
import { helmet } from './packages/vajra/src/security/helmet';

const app = new Vajra();
app.use(helmet());
app.use(cors({ origin: '*' }));
app.use(rateLimit({ max: 1_000_000 }));
app.get('/json', (c) => c.json({ message: 'Hello, World!' }));

app.listen(3001);
console.log('Vajra batteries: http://localhost:3001/json');
