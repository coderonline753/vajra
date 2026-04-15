import { Vajra, cors, rateLimit } from './packages/vajra/src/index';
import { helmet } from './packages/vajra/src/security/helmet';

const app = new Vajra();
app.get('/json', (c) => c.json({ message: 'Hello, World!' }));

app.listen(3001);
console.log('Vajra minimal: http://localhost:3001/json');
