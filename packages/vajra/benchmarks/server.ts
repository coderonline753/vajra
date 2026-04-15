import { Vajra } from '../src/vajra';

const app = new Vajra();

app.get('/', (c) => c.json({ hello: 'vajra' }));
app.get('/users/:id', (c) => c.json({ id: c.param('id') }));

app.listen(3333, () => {
  console.log('Vajra benchmark server on http://localhost:3333');
});
