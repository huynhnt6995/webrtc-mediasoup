import {Router} from 'express'

const productRoutes = Router()
productRoutes.get('/', (req, res) => {
    res.json({'message': 'hello'})
})


const combineRoutes = Router()
combineRoutes.use('/products', productRoutes)

export default combineRoutes