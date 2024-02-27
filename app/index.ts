
import test from './test';
import { getHelloWorld } from './greetings';




//(async function() {

    //await test.example();

    //const message = await getHelloWorld();
    //console.log(message);

//})();



import { User } from './user';

async function createUser() {
    try {
        await User.sync(); // Эта команда создаст таблицу, если она не существует (и не изменит существующую)
        const newUser = await User.create({
            name: 'John Doe',
            email: 'john.doe@example.com',
        });
        console.log(newUser); // Вывод данных нового пользователя
    } catch (error) {
        console.error('Unable to create new user:', error);
    }
}

createUser().then(r => {console.log("Module index - createUser()")});
