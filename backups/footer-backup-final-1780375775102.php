<?if(!defined("B_PROLOG_INCLUDED") || B_PROLOG_INCLUDED!==true)die();?>

            </main>
            <footer class="bg-foreground  text-white py-12">
                <div class="container mx-auto px-4">
                    <!-- Верхняя часть с логотипом -->
                    <div>
                        <a href="/" class="inline-block">
                            <span class="font-serif text-3xl font-semibold"><img src="<?=SITE_TEMPLATE_PATH?>/img/logo_footer.svg" alt=""></span>
                        </a>
                    </div>

                    <!-- Основная часть -->
                    <div class="grid grid-cols-1 lg:grid-cols-5 gap-8 ">
                        <!-- Левая колонка: QR, телефон, мессенджеры -->
                        <div class="lg:col-span-1">
                            <div>
                                <div class="flex gap-3 flex-col">
                                    <p class="mt-4 text-sm leading-relaxed">Кондитерская, в которую возвращаются. С любовью создаём десерты для ваших особенных моментов.</p>
                                    <div class="w-20 h-6  p-1 rounded">
                                        <div class="flex gap-4">
                                            
                                            <a href="https://t.me/maria_irk_bot" target="_blank" title="Telegram" class="text-gray-400 hover:text-accent transition text-white">
                                                <img src="<?=SITE_TEMPLATE_PATH?>/img/tg.svg" class="w-6 h-6">
                                            </a>
                                            <a href="https://vk.com/mariairk" target="_blank" title="Вконтакте" class="text-gray-400 hover:text-accent transition text-white">
                                                <img src="<?=SITE_TEMPLATE_PATH?>/img/vk.svg" class="w-6 h-6">
                                            </a>
                                        </div>
                                    </div>
                                    
                                </div>
                            </div>

                            <div class="mb-6">
                                
                            </div>

                            <?/* <div class="flex gap-4">
                                $APPLICATION->IncludeComponent(
                                    "bitrix:main.include",
                                    "",
                                    Array(
                                        "AREA_FILE_SHOW" => "file",
                                        "AREA_FILE_SUFFIX" => "inc",
                                        "EDIT_TEMPLATE" => "",
                                        "PATH" => "/local/include/footer/soc_seti.php"
                                    )
                                );
                            </div>*/?>
                        </div>

                        <!-- Правая часть: 3 колонки меню -->
                        <div class="lg:col-span-3">
                            <div class="grid grid-cols-1 md:grid-cols-3 gap-8">
                                <!-- О нас -->
                                <div>
                                    <h3 class="text-lg font-semibold mb-4">о нас</h3>
                                    <ul class="space-y-3 text-sm text-gray-400">
                                        <li><a href="/company" class="hover:text-accent transition text-white">История Марии</a></li>
                                        <li><a href="/for_clients" class="hover:text-accent transition text-white">Сладкий чек</a></li>
                                        <li><a href="/company/club" class="hover:text-accent transition text-white">Мария для своих</a></li>
                                        <li><a href="/blog/" class="hover:text-accent transition text-white">Блог</a></li>
                                    </ul>
                                </div>

                                <!-- Клиентам -->
                                <div>
                                    <h3 class="text-lg font-semibold mb-4">клиентам</h3>
                                    <ul class="space-y-3 text-sm text-gray-400">
                                        <li><a href="/sale" class="hover:text-accent transition text-white">Акции</a></li>
                                        <li><a href="/company/news" class="hover:text-accent transition text-white">Новости</a></li>
                                        <li><a href="/help" class="hover:text-accent transition text-white">Доставка и оплата</a></li>
                                        <li><a href="/company/docs" class="hover:text-accent transition text-white">Документация</a></li>
                                    </ul>
                                </div>

                                <!-- Контакты -->
                                <div>
                                    <h3 class="text-lg font-semibold mb-4">контакты</h3>
                                    <div class="space-y-3 text-sm">
                                        <div class="flex">
                                            <?$APPLICATION->IncludeComponent(
                                                "bitrix:main.include",
                                                "",
                                                Array(
                                                    "AREA_FILE_SHOW" => "file",
                                                    "AREA_FILE_SUFFIX" => "inc",
                                                    "EDIT_TEMPLATE" => "",
                                                    "PATH" => "/local/include/footer/phone.php"
                                                )
                                            );?>
                                        </div>
                                        <!-- <li class="flex"><?$APPLICATION->IncludeComponent("bitrix:main.include", "", Array("AREA_FILE_SHOW" => "file", "AREA_FILE_SUFFIX" => "inc", "EDIT_TEMPLATE" => "", "PATH" => "/local/include/footer/address.php"));?></li> -->
                                        <div class="flex"><?$APPLICATION->IncludeComponent("bitrix:main.include", "", Array("AREA_FILE_SHOW" => "file", "AREA_FILE_SUFFIX" => "inc", "EDIT_TEMPLATE" => "", "PATH" => "/local/include/footer/time_work.php"));?></div>
                                        <div class="flex">
                                            
                                            <img src="<?=SITE_TEMPLATE_PATH?>/img/point.svg" class="w-5 h-5 mr-2">
                                        <div class="text-sm "><a href="/contacts">17 кондитерских</div></a></div>
                                        
                                        <!-- <li class="flex"><a href="/contacts" class="hover:text-accent transition text-white">Все контакты</a></li> -->
</div>
                
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Нижняя часть -->
                    <div class="border-t border-gray-800 pt-8">
                        <div class="flex flex-col lg:flex-row justify-between items-center gap-6">
                            <!-- АКИТ -->
                            <!-- <div class="flex items-center gap-2 text-sm text-gray-500">
                                <div class="w-10 h-10 bg-gray-800 rounded-full flex items-center justify-center">
                                    <span class="text-xs font-bold">АКИТ</span>
                                </div>
                                <span>ассоциация компаний интернет-торговли</span>
                            </div> -->

                            <!-- Соцсети -->
                            

                            <!-- Платежные системы -->
                            <!-- <div class="flex gap-3">
                                <div class="h-6 w-10 bg-gray-700 rounded flex items-center justify-center text-xs">VISA</div>
                                <div class="h-6 w-10 bg-gray-700 rounded flex items-center justify-center text-xs">MC</div>
                                <div class="h-6 w-10 bg-gray-700 rounded flex items-center justify-center text-xs">МИР</div>
                            </div> -->
                        </div>
                        <!-- Копирайт и ссылки -->
                        <div class="mt-6 flex flex-col lg:flex-row justify-between items-center gap-4">
                            <p class="text-sm ">
                                © Кондитерская «МАРИЯ» (ИП Кудрявцева Анна Даниловна, ИНН 382703752769). 
                                1997 — <?=date("Y");?> гг. Все права защищены.
                            </p>
                            <div class="flex gap-6 text-sm">
                                <a href="/company/docs/" class=" hover:text-accent transition text-white">Документация</a>
                            </div>
                        </div>
                    </div>
                </div>
            </footer>
            <!-- <footer class="bg-foreground text-primary-foreground">
                <div class="container py-16">
                    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-10">
                        <div><a class="inline-block" href="/"><span
                                    class="font-serif text-3xl font-semibold">Мария</span></a>
                            <?$APPLICATION->IncludeComponent(
                                "bitrix:main.include",
                                "",
                                Array(
                                    "AREA_FILE_SHOW" => "file",
                                    "AREA_FILE_SUFFIX" => "inc",
                                    "EDIT_TEMPLATE" => "",
                                    "PATH" => "/local/include/footer/subtitle.php"
                                )
                            );?>
                            <div class="flex gap-3 mt-6">
                                <?$APPLICATION->IncludeComponent(
                                    "bitrix:main.include",
                                    "",
                                    Array(
                                        "AREA_FILE_SHOW" => "file",
                                        "AREA_FILE_SUFFIX" => "inc",
                                        "EDIT_TEMPLATE" => "",
                                        "PATH" => "/local/include/footer/soc_seti.php"
                                    )
                                );?>
                                
                            </div>
                        </div>
                        <div>
                            <h4 class="font-serif text-lg font-medium mb-4">Навигация</h4>
                            <ul class="space-y-3">
                                <li><a class="text-sm transition-colors text-primary-foreground/70 hover:text-primary-foreground"
                                        href="/catalog">Каталог</a></li>
                                <li><a class="text-sm transition-colors text-accent font-medium hover:text-accent/80"
                                        href="/sweet-score">Сладкий счёт 🎁</a></li>
                                <li><a class="text-sm transition-colors text-primary-foreground/70 hover:text-primary-foreground"
                                        href="/delivery">Доставка и оплата</a></li>
                                <li><a class="text-sm transition-colors text-primary-foreground/70 hover:text-primary-foreground"
                                        href="/club">Клуб «Мария для своих»</a></li>
                                <li><a class="text-sm transition-colors text-primary-foreground/70 hover:text-primary-foreground"
                                        href="/locations">16 кафе</a></li>
                                <li><a class="text-sm transition-colors text-primary-foreground/70 hover:text-primary-foreground"
                                        href="/about">О компании</a></li>
                            </ul>
                        </div>
                        <div>
                            <h4 class="font-serif text-lg font-medium mb-4">Контакты</h4>
                            <ul class="space-y-4">
                                <li class="flex gap-3">
                                    <?$APPLICATION->IncludeComponent(
                                        "bitrix:main.include",
                                        "",
                                        Array(
                                            "AREA_FILE_SHOW" => "file",
                                            "AREA_FILE_SUFFIX" => "inc",
                                            "EDIT_TEMPLATE" => "",
                                            "PATH" => "/local/include/footer/phone.php"
                                        )
                                    );?>
                                </li>
                                <li class="flex gap-3">
                                    <?$APPLICATION->IncludeComponent(
                                        "bitrix:main.include",
                                        "",
                                        Array(
                                            "AREA_FILE_SHOW" => "file",
                                            "AREA_FILE_SUFFIX" => "inc",
                                            "EDIT_TEMPLATE" => "",
                                            "PATH" => "/local/include/footer/address.php"
                                        )
                                    );?>
                                </li>
                                <li class="flex gap-3">
                                    <?$APPLICATION->IncludeComponent(
                                        "bitrix:main.include",
                                        "",
                                        Array(
                                            "AREA_FILE_SHOW" => "file",
                                            "AREA_FILE_SUFFIX" => "inc",
                                            "EDIT_TEMPLATE" => "",
                                            "PATH" => "/local/include/footer/time_work.php"
                                        )
                                    );?>
                                </li>
                            </ul>
                        </div>
                        <div>
                            <h4 class="font-serif text-lg font-medium mb-4">Будьте в курсе</h4>
                            <p class="text-sm text-primary-foreground/70 mb-4">Подпишитесь на новости и специальные
                                предложения</p>
                            <form class="flex gap-2"><input type="email" placeholder="Ваш email"
                                    class="flex-1 px-4 py-2 bg-primary-foreground/10 border border-primary-foreground/20 rounded-lg text-sm placeholder:text-primary-foreground/50 focus:outline-none focus:border-accent"><button
                                    type="submit"
                                    class="px-4 py-2 bg-accent text-accent-foreground rounded-lg text-sm font-medium hover:bg-accent/90 transition-colors">OK</button>
                            </form>
                        </div>
                    </div>
                    <div
                        class="mt-12 pt-8 border-t border-primary-foreground/10 flex flex-col md:flex-row justify-between items-center gap-4">
                        <p class="text-sm text-primary-foreground/50">© Кондитерская «МАРИЯ» (ИП Кудрявцева Анна Даниловна, ИНН 382703752769). 1997 — <?=date("Y");?> гг. Все права защищены.</p>
                        <div class="flex gap-6">
                            <a class="text-sm text-primary-foreground/50 hover:text-primary-foreground transition-colors"
                                href="/privacy">Политика конфиденциальности</a><a
                                class="text-sm text-primary-foreground/50 hover:text-primary-foreground transition-colors"
                                href="/delivery/offer">Соглашение</a>
                        </div>
                    </div>
                </div>
            </footer>   -->
        </div>
        <?
        $APPLICATION->AddHeadScript(SITE_TEMPLATE_PATH . '/js/jquery.js');
        $APPLICATION->AddHeadScript(SITE_TEMPLATE_PATH . '/js/main.js');
        ?>
        <!-- Сама кнопка -->
        <div class="scroll-to-top" id="scrollTopBtn" onclick="scrollToTop()">
            <!-- SVG иконка стрелки вверх -->
            <svg viewBox="0 0 24 24">
                <path d="M12 19V5M5 12l7-7 7 7"/>
            </svg>
        </div>
        <style>
            /* Просто для примера, чтобы было куда скроллить */
            
            /* --- СТИЛИ ДЛЯ КНОПКИ --- */
            .scroll-to-top {
                position: fixed;
                bottom: 10px;
                right: 10px; /* Если нужно слева, поменяй на left: 10px; */
                
                width: 50px;
                height: 50px;
                background-color: hsl(var(--primary) / .1);
                color: white;
                border-radius: 50%; /* Делает кнопку круглой */
                
                display: flex;
                align-items: center;
                justify-content: center;
                
                cursor: pointer;
                box-shadow: 0 4px 10px rgba(0, 0, 0, 0.3);
                
                /* Скрываем кнопку по умолчанию */
                opacity: 0;
                visibility: hidden;
                transform: translateY(20px);
                transition: all 0.3s ease;
                z-index: 1000;
            }

            /* Класс, который добавляем через JS для показа */
            .scroll-to-top.show {
                opacity: 1;
                visibility: visible;
                transform: translateY(0);
            }

            /* Эффект при наведении */
            .scroll-to-top:hover {
                background-color: hsl(var(--primary));
                transform: translateY(-3px); /* Чуть подпрыгивает */
                box-shadow: 0 6px 15px rgba(0, 0, 0, 0.4);
            }

            /* Настройки SVG стрелочки */
            .scroll-to-top:hover svg path{
                stroke: hsl(var(--primary-foreground));
            }
            .scroll-to-top svg path{
                stroke:hsl(var(--primary));
            }
            .scroll-to-top svg {
                width: 24px;
                height: 24px;
                fill: none;
                stroke: currentColor;
                stroke-width: 2;
                stroke-linecap: round;
                stroke-linejoin: round;
            }
            @media (max-width:1280px){
                .scroll-to-top{bottom:78px;}
            }
        </style>
        <script>
            // Получаем кнопку
            const btn = document.getElementById("scrollTopBtn");

            // Слушаем прокрутку страницы
            window.onscroll = function() {
                scrollFunction();
            };

            function scrollFunction() {
                // Если прокрутили больше 300px, показываем кнопку
                if (document.body.scrollTop > 300 || document.documentElement.scrollTop > 300) {
                    btn.classList.add("show");
                } else {
                    btn.classList.remove("show");
                }
            }

            // Функция плавного скролла наверх
            function scrollToTop() {
                window.scrollTo({
                    top: 0,
                    behavior: "smooth" // Плавная прокрутка
                });
            }
        </script>
        <?$APPLICATION->IncludeComponent(
            "bitrix:menu",
            "footer_main_mobile_menu",
            Array(
                "ALLOW_MULTI_SELECT" => "N",
                "CHILD_MENU_TYPE" => "left",
                "COMPONENT_TEMPLATE" => ".default",
                "DELAY" => "N",
                "MAX_LEVEL" => "1",
                "MENU_CACHE_GET_VARS" => "",
                "MENU_CACHE_TIME" => "3600",
                "MENU_CACHE_TYPE" => "N",
                "MENU_CACHE_USE_GROUPS" => "Y",
                "ROOT_MENU_TYPE" => "footer_main_mobile_menu",
                "USE_EXT" => "N"
            )
        );?>
        <?/*$APPLICATION->IncludeComponent(
            "maria:events_popup",
            "",
            Array(
                "ELEMENT" => "23564",
                "IBLOCK_ID" => "69"
            )
        );*/?>
        <div class="bars add_tovar">
            <div class="wrap">
                <div class="icon">
                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-shopping-cart w-5 h-5">
                        <circle cx="8" cy="21" r="1"></circle>
                        <circle cx="19" cy="21" r="1"></circle>
                        <path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"> </path>
                    </svg>
                </div>
                <div class="text">Товар добавлен в корзину</div>
            </div>
        </div>
        <script>
            $(document).ready(function(){
                $(document).on('click', '[id*="buy_link"]', function(e){
                    // e.preventDefault(); // ← Отменяем переход по ссылке
                    
                    let $Bars = $('.bars.add_tovar');
                    $Bars.addClass('active');
                    
                    setTimeout(function () {
                        $Bars.removeClass('active');
                    }, 3000);
                });
                $(document).on('click', '[id*="add_basket_link"]', function(e){
                    // e.preventDefault(); // ← Отменяем переход по ссылке
                    
                    let $Bars = $('.bars.add_tovar');
                    $Bars.addClass('active');
                    
                    setTimeout(function () {
                        $Bars.removeClass('active');
                    }, 3000);
                });
            })
        </script>


        <div class="cookie-svgpopup">
            <div class="cookie-head">
                <svg xmlns="http://www.w3.org/2000/svg" width="157" height="157" viewBox="0 0 157 157" fill="none">
                <g clip-path="url(#clip0_969_12)">
                    <path d="M55.0668 109.743H55.145M78.4997 70.6887H78.5778M39.445 62.8778H39.5231M101.933 109.743H102.011M148.798 78.4997C148.798 117.325 117.325 148.798 78.4997 148.798C39.6749 148.798 8.20117 117.325 8.20117 78.4997C8.20117 39.6749 39.6749 8.20117 78.4997 8.20117C78.4997 29.7705 92.4883 47.2559 109.743 47.2559C109.743 64.5111 127.229 78.4997 148.798 78.4997Z" stroke="#d61f37" stroke-width="15.6219" stroke-linecap="round" stroke-linejoin="round"/>
                </g>
                <defs>
                    <clipPath id="clip0_969_12">
                    <rect width="157" height="157" fill="white"/>
                    </clipPath>
                </defs>
                </svg>
                <h2>Мы используем cookies</h2>
            </div>
            <div class="data">
                <p>Настоящий веб-сайт использует файлы cookie, инструменты Яндекс.Метрики. Продолжая работу с настоящим веб-сайтом, вы подтверждаете свое согласие на обработку/использование cookies вашего браузера, сбора данных Яндекс.Метрики. В противном случае вы можете запретить сохранение/обработку файлов cookie в настройках своего браузера или покинуть настоящий веб-сайт. <a target="_blank" href="/upload/Политика_обработки_файлов_Cookie_Evraas.pdf">Подробнее</a></p>
            </div>
            <div class="cookie-popup-link">
                <a target="_blank" href="/company/docs/?doc=198467">Пользовательское соглашение</a>
                <a target="_blank" href="/company/docs/?doc=198470">Политика конфиденциальности</a>
                <a target="_blank" href="/company/docs/?doc=203271">Обработка данных Яндекс.Метрики</a>
                </div>
            <div class="cookie-buttons">
                <button class="button" id="acceptBtn">Принять</button>
                <!-- <button class="button" id="declineBtn">Decline</button> -->
            </div>
        </div>
        <script>
            const cookieBox = document.querySelector(".cookie-svgpopup"),
                buttons = document.querySelectorAll(".button");

            const executeCodes = () => {
                //if cookie contains codinglab it will be returned and below of this code will not run
                if (document.cookie.includes("codinglab")) return;
                cookieBox.classList.add("show");

                buttons.forEach((button) => {
                button.addEventListener("click", () => {
                    cookieBox.classList.remove("show");

                    //if button has acceptBtn id
                    if (button.id == "acceptBtn") {
                    //set cookies for 1 month. 60 = 1 min, 60 = 1 hours, 24 = 1 day, 30 = 30 days
                    document.cookie = "cookieBy= codinglab; max-age=" + 60 * 60 * 24 * 7;
                    }
                });
                });
            };

            //executeCodes function will be called on webpage load
            window.addEventListener("load", executeCodes);
        </script>
        <?$APPLICATION->IncludeComponent(
            "maria:events_popup",
            "",
            Array(
                "ELEMENT" => "204877",
                "IBLOCK_ID" => "100"
            )
        );?>
    </body>
</html>